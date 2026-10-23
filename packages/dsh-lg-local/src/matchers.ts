/**
 * Token-aware detectors for the default C-class rules.
 *
 * Each runs on one parsed command, so `echo git push --force` or
 * `grep credentials README.md` never match, while `git push -uf`,
 * `rm --recursive --force` and `git push origin +main` do.
 */
import { basename } from 'node:path'

import { gitCall, type GitCall, type Invocation } from './shell.js'

/** A detector returns a short description of what it saw, or `undefined`. */
export type Detector = (command: Invocation) => string | undefined

/** `arg` is `--name` or an accepted abbreviation of it (git and GNU getopt allow those). */
function longOption(arg: string, name: string, min: number): boolean {
  if (!arg.startsWith('--')) return false
  const given = arg.split('=')[0] ?? ''
  return given.length >= min && name.startsWith(given)
}

/** Arguments before a bare `--`. */
function beforeDashes(args: readonly string[]): readonly string[] {
  const end = args.indexOf('--')
  return end === -1 ? args : args.slice(0, end)
}

function shortCluster(arg: string): string | undefined {
  return /^-[A-Za-z0-9]+$/.test(arg) ? arg.slice(1) : undefined
}

function pushCall(call: GitCall): string | undefined {
  for (let i = 0; i < call.args.length; i += 1) {
    const arg = call.args[i] ?? ''
    if (longOption(arg, '--force', 4) || arg.startsWith('--force-')) return `git push ${arg}`
    if (longOption(arg, '--mirror', 3)) return 'git push --mirror'
    if (longOption(arg, '--delete', 4)) return 'git push --delete'
    if (longOption(arg, '--prune', 5)) return 'git push --prune'
    const cluster = shortCluster(arg)
    if (cluster !== undefined && /[fd]/.test(cluster)) return `git push ${arg}`
    if (!arg.startsWith('-') && arg.length > 1 && (arg.startsWith('+') || arg.startsWith(':'))) {
      return `git push with ${arg.startsWith('+') ? 'a forced' : 'a delete'} refspec ${arg}`
    }
    if (call.open[i] === true) return 'git push with an expansion the gate cannot resolve'
  }
  return undefined
}

const forcePush: Detector = (command) => {
  const call = gitCall(command)
  return call?.sub === 'push' ? pushCall(call) : undefined
}

const rmRecursive: Detector = (command) => {
  if (basename(command.argv[0] ?? '') !== 'rm') return undefined
  for (const arg of beforeDashes(command.argv.slice(1))) {
    if (longOption(arg, '--recursive', 3)) return 'rm --recursive'
    const cluster = shortCluster(arg)
    if (cluster !== undefined && /[rR]/.test(cluster)) return `rm ${arg}`
  }
  return undefined
}

const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'lerna', 'changeset', 'npx', 'pnpx', 'bunx'])

const publish: Detector = (command) => {
  const head = basename(command.argv[0] ?? '')
  if (!PUBLISHERS.has(head)) return undefined
  const hit = beforeDashes(command.argv.slice(1)).find((arg) => arg === 'publish' || arg === 'unpublish')
  return hit === undefined ? undefined : `${head} ${hit}`
}

const commitAmend: Detector = (command) => {
  const call = gitCall(command)
  if (call?.sub !== 'commit') return undefined
  return call.args.some((arg) => longOption(arg, '--amend', 4)) ? 'git commit --amend' : undefined
}

const historyRewrite: Detector = (command) => {
  const call = gitCall(command)
  if (call === undefined) return undefined
  if (call.sub === 'filter-branch' || call.sub === 'filter-repo') return `git ${call.sub}`
  if (call.sub === 'rebase') {
    const harmless = call.args.some((arg) => arg === '--abort' || arg === '--quit' || arg === '--show-current-patch')
    return harmless ? undefined : 'git rebase'
  }
  return undefined
}

const resetHard: Detector = (command) => {
  const call = gitCall(command)
  if (call?.sub !== 'reset') return undefined
  return call.args.some((arg) => longOption(arg, '--hard', 4)) ? 'git reset --hard' : undefined
}

const gitClean: Detector = (command) => {
  const call = gitCall(command)
  if (call?.sub !== 'clean') return undefined
  const dry = call.args.some((arg) => longOption(arg, '--dry-run', 4) || /^-[A-Za-z]*n[A-Za-z]*$/.test(arg))
  const force = call.args.some((arg) => longOption(arg, '--force', 4) || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg))
  return force && !dry ? 'git clean -f' : undefined
}

const branchDelete: Detector = (command) => {
  const call = gitCall(command)
  if (call?.sub !== 'branch') return undefined
  const clusters = call.args.map(shortCluster).filter((cluster): cluster is string => cluster !== undefined)
  if (clusters.some((cluster) => cluster.includes('D'))) return 'git branch -D'
  const del = clusters.some((cluster) => cluster.includes('d')) || call.args.some((arg) => longOption(arg, '--delete', 4))
  const force = clusters.some((cluster) => cluster.includes('f')) || call.args.some((arg) => longOption(arg, '--force', 4))
  return del && force ? 'git branch --delete --force' : undefined
}

const CREDENTIAL_FILE = /(^|\/)(\.netrc|_netrc|\.git-credentials|\.aws\/credentials|\.docker\/config\.json)$/
const EMBEDDED_PASSWORD = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/
const CREDENTIAL_ENV = /^(GIT_ASKPASS|SSH_ASKPASS)$/
const READ_ONLY = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', '--show-origin', '--show-scope', '--name-only'])

const credentials: Detector = (command) => {
  if (command.assignments.some((entry) => CREDENTIAL_ENV.test(entry.name))) return 'a GIT_ASKPASS / SSH_ASKPASS setting'
  const call = gitCall(command)
  if (call !== undefined) {
    if (call.config.some((setting) => /^(credential[.=]|core\.askpass)/i.test(setting))) return 'git -c credential setting'
    if (call.sub === 'credential' || call.sub.startsWith('credential-')) return `git ${call.sub}`
    if (call.sub === 'config') {
      const readOnly = call.args.some((arg) => READ_ONLY.has(arg))
      const key = call.args.find((arg) => /^(credential([.=]|$)|core\.askpass)/i.test(arg))
      if (key !== undefined && !readOnly) return `git config ${key}`
    }
  }
  const targets = [...command.words, ...command.redirects, ...command.assignments.map((entry) => entry.value)]
  const path = targets.find((word) => CREDENTIAL_FILE.test(word))
  if (path !== undefined) return `a credential file (${path})`
  const url = targets.find((word) => EMBEDDED_PASSWORD.test(word))
  if (url !== undefined) return 'a URL with an embedded password'
  return undefined
}

/** Detectors by rule id; a rule whose `match` is `builtin:<id>` runs one. */
export const BUILTIN_DETECTORS: Readonly<Record<string, Detector>> = {
  'force-push': forcePush,
  'rm-rf': rmRecursive,
  publish,
  'commit-amend': commitAmend,
  'history-rewrite': historyRewrite,
  'reset-hard': resetHard,
  'git-clean': gitClean,
  'branch-delete': branchDelete,
  credentials,
}
