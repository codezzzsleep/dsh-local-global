/**
 * A small shell tokenizer shared by the action gate and the protected-path guard.
 *
 * It turns command text into simple commands: quotes removed, `\`-newline
 * joined, `;` `&&` `||` `|` split, `sh -c` / `eval` / `$(...)` payloads parsed
 * recursively, wrapper commands (`sudo`, `env`, ...) stripped, and `NAME=value`
 * assignments tracked so `F=--force; git push $F` resolves. An expansion it
 * cannot resolve is flagged, not guessed. It is not a full shell: the aim is to
 * catch accidents and the obvious spellings, never a deliberate bypass.
 */
import { basename } from 'node:path'

/** One command as the shell would run it. */
export interface Invocation {
  /** Program and arguments, wrappers and assignments stripped. */
  readonly argv: readonly string[]
  /** `open[i]` is true when `argv[i]` begins with an expansion that could not be resolved. */
  readonly open: readonly boolean[]
  /** `NAME=value` assignments that apply to this command (prefix, `export`, `env`). */
  readonly assignments: readonly { readonly name: string; readonly value: string }[]
  /** Every word of the command before wrapper stripping. */
  readonly words: readonly string[]
  /** Redirect targets (`> file`, `< file`). */
  readonly redirects: readonly string[]
  /** `argv` joined by single spaces. */
  readonly text: string
}

export interface ParseOptions {
  /** `pwsh` treats the backtick as an escape, not command substitution. */
  readonly dialect?: 'posix' | 'pwsh'
}

interface RawCommand {
  words: string[]
  open: boolean[]
  assignments: { name: string; value: string; open: boolean }[]
  redirects: string[]
  heredoc?: string
  /** A shell that reads its program from stdin: a later heredoc body is code. */
  stdinShell?: boolean
}

interface State {
  readonly out: Invocation[]
  readonly vars: Map<string, string | undefined>
  readonly dialect: 'posix' | 'pwsh'
  depth: number
  /** Nesting went past MAX_DEPTH, so some commands were not seen. */
  truncated: boolean
}

const MAX_DEPTH = 5
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'coproc'])
const EXPORTERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])

/** Options that take a separate value, per wrapper command. */
const WRAPPERS: Readonly<Record<string, { readonly value: readonly string[]; readonly positional?: number }>> = {
  env: { value: ['-u', '-C', '--unset', '--chdir'] },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ['-a'] },
  nohup: { value: [] },
  time: { value: ['-f', '-o', '--format', '--output'] },
  nice: { value: ['-n', '--adjustment'] },
  sudo: { value: ['-u', '-g', '-h', '-p', '-C', '-U', '-D', '-R', '-r', '-t', '-T', '--user', '--group', '--host', '--prompt', '--chdir'] },
  doas: { value: ['-u', '-C'] },
  stdbuf: { value: ['-i', '-o', '-e'] },
  setsid: { value: [] },
  ionice: { value: ['-c', '-n', '-p'] },
  timeout: { value: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  xargs: { value: ['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '--arg-file', '--max-args', '--max-procs', '--delimiter', '--replace'] },
}

/** Whether a tool name is a shell front end. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'pwsh', 'powershell', 'sh', 'zsh', 'shell', 'cmd', 'run_command', 'terminal', 'exec_command']

/**
 * Parse command text into the simple commands it would run.
 * @param text - shell text.
 * @param options - dialect.
 * @returns every command, including those inside `sh -c`, `eval`, and `$(...)`.
 */
export function parseShell(text: string, options: ParseOptions = {}): Invocation[] {
  return parseShellDetailed(text, options).commands
}

/**
 * Like {@link parseShell}, and also says whether nesting was too deep to see
 * every command, so a gate can refuse what it could not inspect.
 */
export function parseShellDetailed(text: string, options: ParseOptions = {}): { commands: Invocation[]; truncated: boolean } {
  const state: State = { out: [], vars: new Map(), dialect: options.dialect ?? 'posix', depth: 0, truncated: false }
  scan(text, state)
  return { commands: state.out, truncated: state.truncated }
}

/** The index of the parenthesis closing the one just before `from`, or the end of the text. */
function closingParen(text: string, from: number): number {
  let depth = 1
  let i = from
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      i = end === -1 ? text.length : end + 1
    } else if (c === '"') {
      i += 1
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i += 1
    } else {
      if (c === '(') depth += 1
      if (c === ')') {
        depth -= 1
        if (depth === 0) return i
      }
      i += 1
    }
  }
  return text.length
}

/** Decode the body of `$'...'`. */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (_all, esc: string) => {
    if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8))
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }
    return map[esc] ?? esc
  })
}

function scan(text: string, state: State): void {
  let raw: RawCommand = { words: [], open: [], assignments: [], redirects: [] }
  let cur = ''
  let inWord = false
  let openStart = false
  let openAny = false
  let redirect: 'none' | 'path' | 'delim' | 'string' = 'none'
  const pending: { delim: string; strip: boolean; command?: RawCommand }[] = []
  let heredocDelim: { strip: boolean } | undefined

  const flushWord = (): void => {
    if (!inWord) return
    const word = cur
    const wasOpen = openStart
    const wasOpenAny = openAny
    cur = ''
    inWord = false
    openStart = false
    openAny = false
    if (redirect === 'delim') {
      pending.push({ delim: word, strip: heredocDelim?.strip ?? false })
      redirect = 'none'
      return
    }
    if (redirect === 'string') {
      raw.heredoc = `${raw.heredoc ?? ''}${word}\n`
      redirect = 'none'
      return
    }
    if (redirect === 'path') {
      if (!/^\d+-?$/.test(word)) raw.redirects.push(word)
      redirect = 'none'
      return
    }
    const assignment = raw.words.length === 0 ? ASSIGN_RE.exec(word) : null
    if (assignment !== null) {
      raw.assignments.push({ name: assignment[1] ?? '', value: word.slice(assignment[0].length), open: wasOpenAny })
      return
    }
    raw.words.push(word)
    raw.open.push(wasOpen)
  }

  const endCommand = (): void => {
    flushWord()
    if (raw.words.length > 0 || raw.assignments.length > 0 || raw.redirects.length > 0 || raw.heredoc !== undefined) {
      const finished = raw
      for (const entry of pending) if (entry.command === undefined) entry.command = finished
      emit(finished, state)
    }
    raw = { words: [], open: [], assignments: [], redirects: [] }
    redirect = 'none'
  }

  /** Append literal text to the word being built. */
  const add = (value: string): void => {
    cur += value
    inWord = true
  }

  /** An expansion nobody can resolve here. */
  const unresolved = (marker: string): void => {
    if (!inWord || cur === '') openStart = true
    openAny = true
    add(marker)
  }

  const expandName = (name: string, quoted: boolean): void => {
    const known = state.vars.has(name) ? state.vars.get(name) : undefined
    if (known === undefined) {
      unresolved(`$${name}`)
      return
    }
    if (quoted) {
      add(known)
      return
    }
    if (known === '') return
    for (const part of known.split(/(\s+)/)) {
      if (part === '') continue
      if (/^\s+$/.test(part)) flushWord()
      else add(part)
    }
  }

  const nested = (payload: string): void => {
    if (state.depth >= MAX_DEPTH) {
      state.truncated = true
      return
    }
    state.depth += 1
    scan(payload, state)
    state.depth -= 1
  }

  /** Handle `$` at `i`; returns the new index. */
  const dollar = (i: number, quoted: boolean): number => {
    const next = text[i + 1]
    if (next === '(') {
      if (text[i + 2] === '(') {
        const end = closingParen(text, i + 3)
        unresolved('$((…))')
        return text[end + 1] === ')' ? end + 2 : end + 1
      }
      const end = closingParen(text, i + 2)
      nested(text.slice(i + 2, end))
      unresolved('$(…)')
      return end + 1
    }
    if (next === '{') {
      const end = text.indexOf('}', i + 2)
      const body = text.slice(i + 2, end === -1 ? text.length : end)
      const name = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(body)
      if (name !== null) expandName(body, quoted)
      else unresolved('${…}')
      return end === -1 ? text.length : end + 1
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = i + 1
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j] ?? '')) j += 1
      expandName(text.slice(i + 1, j), quoted)
      return j
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      unresolved(`$${next}`)
      return i + 2
    }
    if (next === "'" && !quoted) {
      const end = text.indexOf("'", i + 2)
      add(ansiC(text.slice(i + 2, end === -1 ? text.length : end)))
      return end === -1 ? text.length : end + 1
    }
    add('$')
    return i + 1
  }

  /** Handle a backtick at `i` (posix); returns the new index. */
  const backtick = (i: number): number => {
    let j = i + 1
    let body = ''
    while (j < text.length && text[j] !== '`') {
      if (text[j] === '\\' && j + 1 < text.length) {
        body += text[j + 1]
        j += 2
      } else {
        body += text[j]
        j += 1
      }
    }
    nested(body)
    unresolved('`…`')
    return j + 1
  }

  let i = 0
  while (i < text.length) {
    const c = text[i] ?? ''
    if (c === '\\') {
      const next = text[i + 1]
      if (next === '\n') i += 2
      else if (next === '\r' && text[i + 2] === '\n') i += 3
      else if (next === undefined) i += 1
      else {
        add(next)
        i += 2
      }
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      add(text.slice(i + 1, end === -1 ? text.length : end))
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (c === '"') {
      inWord = true
      i += 1
      while (i < text.length && text[i] !== '"') {
        const d = text[i] ?? ''
        if (d === '\\') {
          const next = text[i + 1]
          if (next === '\n') i += 2
          else if (next !== undefined && '$`"\\'.includes(next)) {
            add(next)
            i += 2
          } else {
            add('\\')
            i += 1
          }
        } else if (d === '$') i = dollar(i, true)
        else if (d === '`' && state.dialect === 'posix') i = backtick(i)
        else {
          add(d)
          i += 1
        }
      }
      i += 1
      continue
    }
    if (c === '$') {
      i = dollar(i, false)
      continue
    }
    if (c === '`' && state.dialect === 'posix') {
      i = backtick(i)
      continue
    }
    if (c === '`') {
      const next = text[i + 1]
      if (next !== undefined) add(next)
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flushWord()
      i += 1
      continue
    }
    if (c === '\n') {
      endCommand()
      i += 1
      for (const entry of pending.splice(0)) {
        const lines: string[] = []
        while (i < text.length) {
          const eol = text.indexOf('\n', i)
          const line = text.slice(i, eol === -1 ? text.length : eol)
          i = eol === -1 ? text.length : eol + 1
          const compare = entry.strip ? line.replace(/^\t+/, '') : line
          if (compare === entry.delim) break
          lines.push(line)
        }
        if (entry.command === undefined) continue
        const body = `${lines.join('\n')}\n`
        entry.command.heredoc = `${entry.command.heredoc ?? ''}${body}`
        if (entry.command.stdinShell === true) nested(body)
      }
      continue
    }
    if (c === '#' && !inWord) {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? text.length : eol
      continue
    }
    if (c === ';' || c === '|' || c === '(' || c === ')') {
      endCommand()
      i += c === '|' && (text[i + 1] === '|' || text[i + 1] === '&') ? 2 : 1
      continue
    }
    if (c === '&') {
      if (text[i + 1] === '>') {
        flushWord()
        redirect = 'path'
        i += text[i + 2] === '>' ? 3 : 2
        continue
      }
      endCommand()
      i += text[i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '<' || c === '>') {
      if (text[i + 1] === '(') {
        const end = closingParen(text, i + 2)
        nested(text.slice(i + 2, end))
        unresolved(`${c}(…)`)
        i = end + 1
        continue
      }
      if (inWord && /^\d+$/.test(cur)) {
        cur = ''
        inWord = false
      } else flushWord()
      let op = c
      if (text[i + 1] === c) op += c
      if (c === '<' && op === '<<' && text[i + 2] === '<') op = '<<<'
      if (c === '<' && op === '<<' && text[i + 2] === '-') op = '<<-'
      if (c === '>' && (text[i + 1] === '&' || text[i + 1] === '|')) op = c + (text[i + 1] ?? '')
      if (c === '<' && text[i + 1] === '&') op = '<&'
      i += op.length
      if (op === '<<' || op === '<<-') {
        redirect = 'delim'
        heredocDelim = { strip: op === '<<-' }
      } else if (op === '<<<') redirect = 'string'
      else redirect = 'path'
      continue
    }
    add(c)
    i += 1
  }
  endCommand()
}

/** Record a command, then follow whatever it hands to another shell. */
function emit(raw: RawCommand, state: State): void {
  const assignments = raw.assignments.map(({ name, value }) => ({ name, value }))
  let argv = [...raw.words]
  let open = [...raw.open]

  while (argv.length > 0 && RESERVED.has(argv[0] ?? '')) {
    argv.shift()
    open.shift()
  }

  // An assignment-only command, or `export NAME=value`, defines variables for later commands.
  if (argv.length === 0) {
    for (const entry of raw.assignments) state.vars.set(entry.name, entry.open ? undefined : entry.value)
  } else if (EXPORTERS.has(basename(argv[0] ?? ''))) {
    for (const word of argv.slice(1)) {
      const found = ASSIGN_RE.exec(word)
      if (found === null) continue
      assignments.push({ name: found[1] ?? '', value: word.slice(found[0].length) })
      state.vars.set(found[1] ?? '', word.slice(found[0].length))
    }
  }

  // Strip wrapper commands (`sudo`, `env`, `nohup`, ...).
  for (let guard = 0; guard < 8 && argv.length > 0; guard += 1) {
    const head = basename(argv[0] ?? '')
    const spec = WRAPPERS[head]
    if (spec === undefined) break
    let j = 1
    let skipped = 0
    while (j < argv.length) {
      const arg = argv[j] ?? ''
      if (arg === '--') {
        j += 1
        break
      }
      if (head === 'env' && ASSIGN_RE.test(arg)) {
        const found = ASSIGN_RE.exec(arg)
        assignments.push({ name: found?.[1] ?? '', value: arg.slice(found?.[0].length ?? 0) })
        j += 1
        continue
      }
      if (arg.length > 1 && arg.startsWith('-')) {
        j += spec.value.includes(arg) ? 2 : 1
        continue
      }
      if (spec.positional !== undefined && skipped < spec.positional) {
        skipped += 1
        j += 1
        continue
      }
      break
    }
    argv = argv.slice(j)
    open = open.slice(j)
  }

  if (argv.length > 0 || assignments.length > 0 || raw.redirects.length > 0) {
    state.out.push({ argv, open, assignments, words: [...raw.words], redirects: [...raw.redirects], text: argv.join(' ') })
  }
  if (argv.length === 0) return
  const head = basename(argv[0] ?? '')
  if (state.depth >= MAX_DEPTH) {
    if (SHELLS.has(head) || head === 'eval') state.truncated = true
    return
  }
  state.depth += 1
  try {
    if (SHELLS.has(head)) {
      const payload = shellPayload(argv)
      if (payload !== undefined) scan(payload, state)
      else if (raw.heredoc !== undefined) scan(raw.heredoc, state)
      else raw.stdinShell = true
    } else if (head === 'eval') {
      scan(argv.slice(1).join(' '), state)
    } else if (head === 'find') {
      const from = argv.findIndex((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))
      if (from !== -1) {
        const rest = argv.slice(from + 1)
        const end = rest.findIndex((arg) => arg === ';' || arg === '+')
        scan((end === -1 ? rest : rest.slice(0, end)).join(' '), state)
      }
    }
  } finally {
    state.depth -= 1
  }
}

/** The `-c` payload of `sh -c '...'`, if there is one. */
function shellPayload(argv: readonly string[]): string | undefined {
  let sawC = false
  for (let j = 1; j < argv.length; j += 1) {
    const arg = argv[j] ?? ''
    if (arg === '--') return sawC ? argv[j + 1] : undefined
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg.startsWith('-') && arg.includes('c')) sawC = true
      if (arg.endsWith('o')) j += 1
      continue
    }
    return sawC ? arg : undefined
  }
  return undefined
}

/** The git subcommand an invocation runs, with its arguments and `-c` settings. */
export interface GitCall {
  readonly sub: string
  readonly args: readonly string[]
  readonly open: readonly boolean[]
  readonly config: readonly string[]
}

/**
 * Read `git [global options] <sub> args...`, also as `git-<sub> args...`.
 * @param inv - one parsed command.
 * @returns the call, or `undefined` when it is not git.
 */
export function gitCall(inv: Invocation): GitCall | undefined {
  const head = basename(inv.argv[0] ?? '')
  const direct = /^git-(.+)$/.exec(head)
  if (direct !== null) return { sub: direct[1] ?? '', args: inv.argv.slice(1), open: inv.open.slice(1), config: [] }
  if (head !== 'git') return undefined
  const config: string[] = []
  let j = 1
  while (j < inv.argv.length) {
    const arg = inv.argv[j] ?? ''
    if (arg === '-c' || arg === '--config-env') {
      config.push(inv.argv[j + 1] ?? '')
      j += 2
    } else if (['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'].includes(arg)) j += 2
    else if (arg.startsWith('-')) j += 1
    else break
  }
  const sub = inv.argv[j]
  if (sub === undefined) return undefined
  return { sub, args: inv.argv.slice(j + 1), open: inv.open.slice(j + 1), config }
}
