/**
 * `lg-evidence` — evidence that is original, not a summary.
 *
 * A manifest binds a claim to the version it was observed at, to the raw files
 * that back it (by sha256), and to the negatives and controls that make it mean
 * something. `real` evidence must contain at least one raw file this plugin
 * produced by running the command itself, so "I ran it" can be checked instead
 * of believed (SPEC "lg-evidence", EV-1…EV-5).
 *
 * Two fields name the version, and they differ on purpose:
 * - `commit` is `git rev-parse HEAD` when the evidence was written.
 * - `digest` is what the claim is about. By default it is the git tree of the
 *   working tree *excluding the evidence root*: committing a manifest, or
 *   changing another manifest, leaves it alone, while any change to the code
 *   under test, committed or not, moves it. A configured `digestCommand` (an
 *   artifact hash, say) replaces it (design.md: "commit 或产物 digest").
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

import { gateReason, resolveActionGateConfig, type ActionGateService } from './action-gate.js'
import { expandTilde, physicalPath, provide, service, sessionCwd, within } from './common.js'
import { protectReason, resolveProtectConfig, type ProtectService } from './protect.js'

export const name = 'lg-evidence'
export const inject = ['tools']

/** Patterns that must never reach a manifest (SPEC "发布前密钥扫描"). */
export const DEFAULT_SECRET_PATTERNS: readonly string[] = [
  'token=[A-Za-z0-9_\\-]{10,}',
  'Authorization:',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'sk-[A-Za-z0-9]{16,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY',
]

/** The built-in digest: tree of the working tree without the evidence root. */
export const TREE_DIGEST = 'git:tree'

/** Config for one `lg-evidence` instance. */
export interface EvidenceConfig {
  /** {@link TREE_DIGEST}, or a shell command whose trimmed stdout is the digest. */
  readonly digestCommand: string
  readonly secretPatterns: readonly string[]
  /** Public domains that must not appear in evidence (SPEC EV-5); subdomains match too. */
  readonly publicDomains: readonly string[]
  readonly evidenceRoot: string
}

/** Raw config as it arrives from the profile. */
export interface RawEvidenceConfig {
  readonly digestCommand?: unknown
  readonly secretPatterns?: unknown
  readonly publicDomains?: unknown
  readonly evidenceRoot?: unknown
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * Resolve and validate the plugin config.
 * @param raw - profile-supplied config; `digestCommand` may be a string or an argv list.
 * @param cwd - base for a relative `evidenceRoot`.
 * @returns the effective config.
 * @throws {TypeError} when a secret pattern is not a valid regular expression.
 */
export function resolveEvidenceConfig(raw: RawEvidenceConfig, cwd: string): EvidenceConfig {
  const digestCommand =
    typeof raw.digestCommand === 'string' && raw.digestCommand.length > 0
      ? raw.digestCommand
      : Array.isArray(raw.digestCommand) && raw.digestCommand.length > 0
        ? raw.digestCommand.map((word) => shellQuote(String(word))).join(' ')
        : TREE_DIGEST
  const secretPatterns =
    Array.isArray(raw.secretPatterns) && raw.secretPatterns.length > 0 ? raw.secretPatterns.map((value) => String(value)) : [...DEFAULT_SECRET_PATTERNS]
  for (const pattern of secretPatterns) {
    try {
      new RegExp(pattern, 'i')
    } catch {
      throw new TypeError(`lg-evidence: secret pattern ${JSON.stringify(pattern)} is not a valid regular expression`)
    }
  }
  const publicDomains = Array.isArray(raw.publicDomains)
    ? raw.publicDomains.map((value) => String(value).trim().toLowerCase()).filter((value) => value.length > 0)
    : []
  const evidenceRoot = typeof raw.evidenceRoot === 'string' && raw.evidenceRoot.length > 0 ? resolvePath(cwd, raw.evidenceRoot) : resolvePath(cwd, 'evidence')
  return { digestCommand, secretPatterns, publicDomains, evidenceRoot }
}

/** One raw file backing a claim. */
export interface RawFile {
  /** Absolute path when the manifest was written. */
  readonly path: string
  /** Path relative to the evidence root when the file sits inside it; survives moving the repository. */
  readonly rel?: string
  readonly sha256: string
  readonly bytes: number
  /** Present only when this plugin produced the file by running the command. */
  readonly producedByTool?: {
    readonly command: string
    readonly exitCode: number
    readonly startedAt: string
    readonly endedAt: string
    readonly hostname: string
    readonly dshVersion: string
  }
}

/** One claim's manifest. */
export interface Manifest {
  readonly topic: string
  readonly claim: string
  readonly environment: 'real' | 'simulated'
  readonly targetEnvironment?: string
  readonly command: string
  /** `git rev-parse HEAD` when written. */
  readonly commit: string
  /** The version the claim is about; see the module comment. */
  readonly digest: string
  readonly digestKind?: 'tree' | 'command'
  /** Whether the worktree (outside the evidence root) had uncommitted changes when written. */
  readonly worktreeDirty?: boolean
  readonly dirtyPaths?: readonly string[]
  readonly raw: readonly RawFile[]
  readonly negativeTests: readonly string[]
  readonly controls: readonly string[]
  readonly result: string
  readonly writtenAt: string
}

/** What `lg_evidence_check` reports about one manifest. */
export interface ManifestStatus {
  readonly topic: string
  readonly path: string
  readonly digest: string
  readonly current: string
  readonly stale: boolean
  /** Why it is stale; empty when current. */
  readonly reasons: readonly string[]
  /** The evidence was written on a worktree with uncommitted changes. */
  readonly dirtyAtCreation: boolean
}

/**
 * Split manifests into current and stale by digest (EV-4).
 *
 * Pure so the classification can be unit-tested without a live digest command.
 * @param entries - `[topic, manifestDigest]` pairs.
 * @param current - the digest right now.
 * @returns the topics whose digest differs.
 */
export function staleOf(entries: readonly (readonly [string, string])[], current: string): string[] {
  return entries.filter(([, digest]) => digest !== current).map(([topic]) => topic)
}

/**
 * Which secret patterns a text matches.
 * @param text - file contents.
 * @param patterns - configured patterns.
 * @returns the matching patterns.
 */
export function secretHits(text: string, patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => new RegExp(pattern, 'i').test(text))
}

/**
 * Which configured public domains a text names, subdomains included.
 * @param text - file contents.
 * @param domains - lowercase domains.
 * @returns the domains found.
 */
export function domainHits(text: string, domains: readonly string[]): string[] {
  const lower = text.toLowerCase()
  return domains.filter((domain) => {
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9-])(?:[a-z0-9-]+\\.)*${escaped}(?![a-z0-9-])`).test(lower)
  })
}

/** Everything the scan refuses in one text, as short labels (never the match itself). */
function scanHits(text: string, config: EvidenceConfig): string[] {
  return [...secretHits(text, config.secretPatterns), ...domainHits(text, config.publicDomains).map((domain) => `public domain ${domain}`)]
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Validate a topic and locate its directory.
 *
 * A topic is `a` or `a/b/c` of plain segments: no `..`, no absolute path, no
 * `raw`, and no symlinked ancestor that leads out of the evidence root.
 * @param root - the evidence root.
 * @param topic - what the caller passed.
 * @returns the topic and its directory.
 * @throws {Error} when the topic is unsafe.
 */
export function topicDir(root: string, topic: string): { topic: string; dir: string } {
  const segments = topic.split('/')
  if (topic.length === 0 || topic.length > 200 || segments.length > 6 || segments.some((segment) => !SEGMENT.test(segment) || segment === 'raw')) {
    throw new Error(`lg_evidence_add: topic ${JSON.stringify(topic)} must be plain path segments such as "M3/ev-real" (no "..", no absolute path, no "raw")`)
  }
  const dir = join(root, ...segments)
  if (!within(physicalPath(root), physicalPath(dir))) throw new Error(`lg_evidence_add: topic ${JSON.stringify(topic)} resolves outside the evidence root`)
  return { topic, dir }
}

/** Run a shell command and capture everything the manifest has to record. */
function runCommand(command: string, cwd: string): { stdout: string; stderr: string; exitCode: number; signal: string | null; startedAt: string; endedAt: string } {
  const startedAt = new Date().toISOString()
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
  const endedAt = new Date().toISOString()
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    signal: result.signal,
    startedAt,
    endedAt,
  }
}

let cachedDshVersion: string | undefined

/** The dsh version this process runs under, best effort. */
function dshVersion(): string {
  if (cachedDshVersion !== undefined) return cachedDshVersion
  try {
    cachedDshVersion = execFileSync('dsh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    cachedDshVersion = 'unknown'
  }
  return cachedDshVersion
}

function git(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', ...(env === undefined ? {} : { env }) })
  if (result.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`)
  return result.stdout
}

/** The version a manifest binds to, as observed now. */
export interface VersionState {
  readonly commit: string
  readonly digest: string
  readonly digestKind: 'tree' | 'command'
  readonly dirty: boolean
  readonly dirtyPaths: readonly string[]
}

/** Tree of the working tree (tracked and untracked, ignoring ignored) without `excluded`. */
function workingTree(top: string, excluded: string | undefined): string {
  const scratch = mkdtempSync(join(tmpdir(), 'lg-digest-'))
  try {
    const index = join(scratch, 'index')
    const real = resolvePath(top, git(['rev-parse', '--git-path', 'index'], top).trim())
    // Start from the real index so unchanged files are not rehashed.
    if (existsSync(real)) copyFileSync(real, index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    git(['add', '-A', '--', '.'], top, env)
    if (excluded !== undefined) git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', excluded], top, env)
    return git(['write-tree'], top, env).trim()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Observe the version evidence would bind to right now.
 * @param config - effective config.
 * @param dir - a directory inside the repository (the evidence root's, or an ancestor that exists).
 * @returns commit, digest, and whether the worktree is dirty outside the evidence root.
 * @throws {Error} when git or the digest command fails; evidence is never bound to an unknown version.
 */
export function versionState(config: EvidenceConfig, dir: string): VersionState {
  const top = physicalPath(git(['rev-parse', '--show-toplevel'], dir).trim())
  const commit = git(['rev-parse', 'HEAD'], top).trim()
  const rel = relative(top, physicalPath(config.evidenceRoot))
  const excluded = rel !== '' && !rel.startsWith('..') ? rel : undefined

  const status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...(excluded === undefined ? [] : [`:(exclude)${excluded}`])], top)
  const dirtyPaths = status
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))

  if (config.digestCommand === TREE_DIGEST) {
    return { commit, digest: workingTree(top, excluded), digestKind: 'tree', dirty: dirtyPaths.length > 0, dirtyPaths: dirtyPaths.slice(0, 50) }
  }
  const run = spawnSync('/bin/sh', ['-c', config.digestCommand], { cwd: top, encoding: 'utf8' })
  const digest = (run.stdout ?? '').trim()
  if (run.status !== 0 || digest === '') throw new Error(`digest command failed (exit ${String(run.status)}): ${(run.stderr ?? '').trim()}`)
  return { commit, digest, digestKind: 'command', dirty: dirtyPaths.length > 0, dirtyPaths: dirtyPaths.slice(0, 50) }
}

/** The nearest directory at or above `path` that exists. */
function existingAncestor(path: string): string {
  let here = path
  while (!existsSync(here) && dirname(here) !== here) here = dirname(here)
  return here
}

/**
 * Why a manifest no longer proves its claim.
 * @param manifest - the parsed manifest.
 * @param current - the digest now, or `undefined` when it cannot be computed.
 * @param root - the evidence root, for relative raw paths.
 * @returns reasons; empty means current.
 */
export function staleReasons(manifest: Manifest, current: string | undefined, root: string): string[] {
  const reasons: string[] = []
  if (current === undefined) reasons.push('current digest unavailable')
  else if (manifest.digest !== current) reasons.push('digest moved: the code under test changed since this was observed')
  for (const raw of manifest.raw ?? []) {
    const file = [raw.rel === undefined ? undefined : join(root, raw.rel), raw.path].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate))
    if (file === undefined) {
      reasons.push(`raw file missing: ${raw.rel ?? raw.path}`)
      continue
    }
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== raw.sha256) reasons.push(`raw file changed: ${raw.rel ?? raw.path}`)
  }
  return reasons
}

/** Last lines of an output, for an error message. */
function tail(text: string): string {
  return text.trim().split('\n').slice(-6).join('\n').slice(-400)
}

export function apply(ctx: Context, raw: RawEvidenceConfig = {}): void {
  const config = resolveEvidenceConfig(raw, process.cwd())

  /** Commit, digest, and dirtiness at the evidence root's repository. */
  const observe = (): VersionState => versionState(config, existingAncestor(config.evidenceRoot))

  /** Current digest, or the error text when it cannot be computed. */
  const digest = (): string => {
    try {
      return observe().digest
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const walk = (visit: (topic: string, dir: string) => void): void => {
    const recurse = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'raw') continue
        const topic = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        visit(topic, join(dir, entry.name))
        recurse(join(dir, entry.name), topic)
      }
    }
    recurse(config.evidenceRoot, '')
  }

  /** Every manifest under the evidence root, at any depth (topics nest: `M3/ev-real`). */
  const manifestsOnDisk = (): [string, string][] => {
    const found: [string, string][] = []
    walk((topic, dir) => {
      const path = join(dir, 'manifest.json')
      if (existsSync(path)) found.push([topic, path])
    })
    return found
  }

  const manifestPath = (topic: string): string => join(config.evidenceRoot, topic, 'manifest.json')

  /** Classify every manifest against the version right now. */
  const statuses = (): { current: string; rows: ManifestStatus[] } => {
    let current: string | undefined
    let why = ''
    try {
      current = observe().digest
    } catch (error) {
      why = error instanceof Error ? error.message : String(error)
    }
    const rows = manifestsOnDisk().map(([topic, path]): ManifestStatus => {
      let manifest: Manifest
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
      } catch (error) {
        return { topic, path, digest: '', current: current ?? '', stale: true, reasons: [`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`], dirtyAtCreation: false }
      }
      const reasons = staleReasons(manifest, current, config.evidenceRoot)
      if (current === undefined && why !== '') reasons[0] = `current digest unavailable: ${why}`
      return { topic, path, digest: String(manifest.digest), current: current ?? '', stale: reasons.length > 0, reasons, dirtyAtCreation: manifest.worktreeDirty === true }
    })
    return { current: current ?? `unavailable: ${why}`, rows }
  }

  /** The action gate's verdict on a command this plugin is about to run itself. */
  const authorize = (command: string): string | undefined => {
    const gate = service<ActionGateService>(ctx, 'lgActionGate')
    if (gate?.authorize !== undefined) return gate.authorize('bash', { command })
    // No gate composed: still refuse C-class commands; nothing can approve them here.
    return gateReason(resolveActionGateConfig({}), 'bash', { command }, [], () => undefined)
  }

  /** The protected-path guard's verdict on this call's paths and command. */
  const protectedPaths = (input: unknown, cwd: string): string | undefined => {
    const guard = service<ProtectService>(ctx, 'lgProtect')
    if (guard?.check !== undefined) return guard.check('lg_evidence_add', input, cwd)
    return protectReason(resolveProtectConfig({}), 'lg_evidence_add', input, cwd)
  }

  ctx.tools.register({
    name: 'lg_evidence_add',
    description:
      'Write an evidence manifest binding a claim to the current commit and digest, to its raw files (by sha256), negatives and controls. In a real environment the plugin runs the command itself (through the action gate and the protected-path guard) and keeps its output as a raw file; a command that exits with a status other than expected_exit_code (default 0) is refused, not recorded. Anything containing a token, key, or configured public domain is refused until redacted.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        claim: { type: 'string' },
        environment: { type: 'string', enum: ['real', 'simulated'] },
        target_environment: { type: 'string' },
        command: { type: 'string' },
        raw: { type: 'array', items: { type: 'string' } },
        negative_tests: { type: 'array', items: { type: 'string' } },
        controls: { type: 'array', items: { type: 'string' } },
        result: { type: 'string' },
        expected_exit_code: { type: 'integer', description: 'Exit status the command is expected to end with; 0 unless it is a negative test' },
      },
      required: ['topic', 'claim', 'environment', 'command', 'raw', 'result'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          digest: { type: 'string' },
          commit: { type: 'string' },
          rawFiles: { type: 'number' },
          producedByTool: { type: 'boolean' },
          exitCode: { type: 'number' },
          worktreeDirty: { type: 'boolean' },
        },
        required: ['path', 'digest', 'commit', 'rawFiles', 'producedByTool'],
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { path?: unknown; digest?: unknown; rawFiles?: unknown; producedByTool?: unknown; worktreeDirty?: unknown }
        const dirty = v.worktreeDirty === true ? '; worktree had uncommitted changes' : ''
        return [{ type: 'text' as const, text: `manifest ${String(v.path)} at ${String(v.digest)} (${String(v.rawFiles)} raw file(s), tool-produced: ${String(v.producedByTool)}${dirty})` }]
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }) {
      const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
      const environment = input['environment'] === 'real' ? 'real' : 'simulated'
      const command = String(input['command'])
      const cwd = sessionCwd(ctx, exec.agent)
      const { topic, dir } = topicDir(config.evidenceRoot, String(input['topic']))
      if (!Array.isArray(input['raw'])) throw new Error('lg_evidence_add: "raw" must be a list of file paths (possibly empty)')
      const rawPaths = (input['raw'] as unknown[]).map((value) => String(value))
      const expectedExit = Number.isInteger(input['expected_exit_code']) ? (input['expected_exit_code'] as number) : 0

      const claim = String(input['claim'])
      const result = String(input['result'])
      const negativeTests = ((input['negative_tests'] as unknown[] | undefined) ?? []).map(String)
      const controls = ((input['controls'] as unknown[] | undefined) ?? []).map(String)
      const targetEnvironment = typeof input['target_environment'] === 'string' ? input['target_environment'] : undefined

      // EV-5: the manifest's own text is scanned like the raw files, before anything can run.
      for (const [label, text] of [['topic', topic], ['claim', claim], ['command', command], ['result', result], ['target_environment', targetEnvironment ?? ''], ['negative_tests', negativeTests.join('\n')], ['controls', controls.join('\n')]] as const) {
        const hits = scanHits(text, config)
        if (hits.length > 0) throw new Error(`lg_evidence_add: ${label} contains ${hits.join(', ')}; redact it before writing the manifest`)
      }

      // Nothing runs or is written for a refused call; the approval is spent last.
      const protectedReason = protectedPaths({ ...input, raw: rawPaths }, cwd)
      if (protectedReason !== undefined) throw new Error(protectedReason)
      if (environment === 'real') {
        const denied = authorize(command)
        if (denied !== undefined) throw new Error(denied)
      }

      // Everything is staged in memory; the first write happens after every refusal.
      const staged: { path: string; data: Buffer; producedByTool?: NonNullable<RawFile['producedByTool']> }[] = []
      if (environment === 'real') {
        const run = runCommand(command, cwd)
        if (run.exitCode !== expectedExit) {
          const how = run.signal === null ? `status ${String(run.exitCode)}` : `signal ${run.signal}`
          const excerpt = tail(`${run.stdout}\n${run.stderr}`)
          throw new Error(
            `lg_evidence_add: the command ended with ${how}, expected ${String(expectedExit)}; no evidence was recorded for a failing run.${scanHits(excerpt, config).length === 0 && excerpt !== '' ? ` Output tail:\n${excerpt}` : ''}`,
          )
        }
        const output = `${run.stdout}${run.stderr === '' ? '' : `\n--- stderr ---\n${run.stderr}`}`
        staged.push({
          path: join(dir, 'raw', 'command-output.txt'),
          data: Buffer.from(output, 'utf8'),
          producedByTool: { command, exitCode: run.exitCode, startedAt: run.startedAt, endedAt: run.endedAt, hostname: hostname(), dshVersion: dshVersion() },
        })
      }
      for (const path of rawPaths) {
        const resolved = resolvePath(cwd, expandTilde(path))
        if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`lg_evidence_add: raw file does not exist: ${path}`)
        staged.push({ path: resolved, data: readFileSync(resolved) })
      }
      // EV-2: a real claim with no tool-produced file is not real evidence.
      if (environment === 'real' && !staged.some((file) => file.producedByTool !== undefined)) {
        throw new Error('lg_evidence_add: real evidence needs at least one file produced by running the command')
      }
      for (const file of staged) {
        const hits = scanHits(file.data.toString('utf8'), config)
        if (hits.length > 0) throw new Error(`lg_evidence_add: ${file.path} contains ${hits.join(', ')}; redact it before writing the manifest`)
      }

      // The version is observed after the command ran: that is the state its output describes.
      const version = observe()
      const rawFiles: RawFile[] = staged.map((file) => {
        const rel = relative(config.evidenceRoot, file.path)
        return {
          path: file.path,
          ...(rel.startsWith('..') ? {} : { rel }),
          sha256: createHash('sha256').update(file.data).digest('hex'),
          bytes: file.data.length,
          ...(file.producedByTool === undefined ? {} : { producedByTool: file.producedByTool }),
        }
      })
      const manifest: Manifest = {
        topic,
        claim,
        environment,
        ...(targetEnvironment === undefined ? {} : { targetEnvironment }),
        command,
        commit: version.commit,
        digest: version.digest,
        digestKind: version.digestKind,
        worktreeDirty: version.dirty,
        ...(version.dirty ? { dirtyPaths: version.dirtyPaths } : {}),
        raw: rawFiles,
        negativeTests,
        controls,
        result,
        writtenAt: new Date().toISOString(),
      }

      const written: string[] = []
      const createdDirs: string[] = []
      try {
        for (const file of staged.filter((entry) => entry.producedByTool !== undefined)) {
          for (let made = dirname(file.path); !existsSync(made) && within(config.evidenceRoot, made); made = dirname(made)) createdDirs.push(made)
          mkdirSync(dirname(file.path), { recursive: true })
          writeFileSync(file.path, file.data)
          written.push(file.path)
        }
        for (let made = dir; !existsSync(made) && within(config.evidenceRoot, made); made = dirname(made)) createdDirs.push(made)
        mkdirSync(dir, { recursive: true })
        writeFileSync(manifestPath(topic), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      } catch (error) {
        for (const file of written) rmSync(file, { force: true })
        for (const made of createdDirs) {
          try {
            rmdirSync(made)
          } catch {
            // not empty or already gone
          }
        }
        throw error
      }
      return {
        path: manifestPath(topic),
        digest: manifest.digest,
        commit: manifest.commit,
        rawFiles: rawFiles.length,
        producedByTool: staged.some((file) => file.producedByTool !== undefined),
        exitCode: staged.find((file) => file.producedByTool !== undefined)?.producedByTool?.exitCode ?? 0,
        worktreeDirty: version.dirty,
      }
    },
  })

  // Published so lg-channel can refuse a REPORT that cites a stale manifest
  // (EV-4) without either package importing the other.
  ctx.effect(() =>
    provide(ctx, 'lgEvidence', {
      staleTopics: (): string[] => statuses().rows.filter((row) => row.stale).map((row) => row.topic),
      digest,
      // RG-1 condition 3: raw evidence with no manifest beside it, optionally
      // only what was written at or after `sinceMs` (this turn's evidence).
      missingManifests: (sinceMs?: number): string[] => {
        const orphans: string[] = []
        walk((topic, dir) => {
          const rawDir = join(dir, 'raw')
          if (existsSync(join(dir, 'manifest.json')) || !existsSync(rawDir)) return
          if (sinceMs !== undefined && newestMtime(rawDir) < sinceMs) return
          orphans.push(topic)
        })
        return orphans
      },
    }),
  )

  ctx.tools.register({
    name: 'lg_evidence_check',
    description:
      'Scan every evidence manifest and mark as stale the ones whose digest no longer matches the current one, or whose raw files are missing or changed. Also reports evidence that was written on a dirty worktree.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        properties: {
          current: { type: 'string' },
          manifests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                topic: { type: 'string' },
                digest: { type: 'string' },
                stale: { type: 'boolean' },
                reasons: { type: 'array', items: { type: 'string' } },
                dirtyAtCreation: { type: 'boolean' },
              },
              required: ['topic', 'digest', 'stale'],
            },
          },
        },
        required: ['current', 'manifests'],
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { current?: unknown; manifests?: ManifestStatus[] }
        const rows = (v.manifests ?? []).map(
          (row) => `${row.stale ? 'STALE' : 'ok'} ${row.topic}${row.dirtyAtCreation ? ' (written on a dirty worktree)' : ''}${row.reasons.length > 0 ? ` — ${row.reasons.join('; ')}` : ''}`,
        )
        return [{ type: 'text' as const, text: [`current digest ${String(v.current)}`, ...rows].join('\n') }]
      },
    },
    async execute() {
      const { current, rows } = statuses()
      return { current, manifests: rows }
    },
  })
}

/** Newest modification time under a directory, in ms; 0 when empty. */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const time = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs
    if (time > newest) newest = time
  }
  return newest
}
