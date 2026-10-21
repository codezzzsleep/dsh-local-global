/**
 * `lg-evidence` — evidence that is original, not a summary.
 *
 * A manifest binds a claim to the commit and digest it was observed at, to the
 * raw files that back it, and to the negatives and controls that make it mean
 * something. `real` evidence must contain at least one raw file this plugin
 * produced by running the command itself, so "I ran it" can be checked instead
 * of believed (SPEC "lg-evidence", EV-1…EV-5).
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.tools` is declared in dsh-tools.
import type {} from '@deepseek-ai/dsh-tools'

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

/** Config for one `lg-evidence` instance. */
export interface EvidenceConfig {
  readonly digestCommand: string
  readonly secretPatterns: readonly string[]
  readonly evidenceRoot: string
}

/** Raw config as it arrives from the profile. */
export interface RawEvidenceConfig {
  readonly digestCommand?: unknown
  readonly secretPatterns?: unknown
  readonly evidenceRoot?: unknown
}

/**
 * Resolve and validate the plugin config.
 * @param raw - profile-supplied config.
 * @param cwd - base for a relative `evidenceRoot`.
 * @returns the effective config.
 */
export function resolveEvidenceConfig(raw: RawEvidenceConfig, cwd: string): EvidenceConfig {
  const digestCommand = typeof raw.digestCommand === 'string' && raw.digestCommand.length > 0 ? raw.digestCommand : 'git rev-parse HEAD'
  const secretPatterns = Array.isArray(raw.secretPatterns) && raw.secretPatterns.length > 0
    ? raw.secretPatterns.map((value) => String(value))
    : [...DEFAULT_SECRET_PATTERNS]
  const evidenceRoot = typeof raw.evidenceRoot === 'string' && raw.evidenceRoot.length > 0 ? resolvePath(cwd, raw.evidenceRoot) : resolvePath(cwd, 'evidence')
  return { digestCommand, secretPatterns, evidenceRoot }
}

/** One raw file backing a claim. */
export interface RawFile {
  readonly path: string
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
  readonly commit: string
  readonly digest: string
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

/** sha256 of a string, hex. */
function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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

/** Run a shell command and capture everything the manifest has to record. */
function runCommand(command: string, cwd: string): { stdout: string; stderr: string; exitCode: number; startedAt: string; endedAt: string } {
  const startedAt = new Date().toISOString()
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 600_000 })
  const endedAt = new Date().toISOString()
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
    startedAt,
    endedAt,
  }
}

/** The dsh version this process runs under, best effort. */
function dshVersion(): string {
  try {
    return execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function apply(ctx: Context, raw: RawEvidenceConfig = {}): void {
  const config = resolveEvidenceConfig(raw, process.cwd())

  /** Current digest, or the error text when the command fails. */
  const digest = (): string => {
    try {
      return execFileSync('/bin/sh', ['-c', config.digestCommand], { encoding: 'utf8' }).trim()
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const manifestPath = (topic: string): string => join(config.evidenceRoot, topic, 'manifest.json')

  /**
   * Every manifest under the evidence root, at any depth.
   *
   * Topics are allowed to nest (`M3/ev-real`), so a depth-1 readdir misses
   * them — that was a real bug: the checker reported "none" while manifests sat
   * one directory deeper.
   * @returns `[topic, path]` pairs, topic relative to the evidence root.
   */
  /** Every topic directory under the evidence root, at any depth. */
  const topicsOnDisk = (): [string, string][] => {
    const found: [string, string][] = []
    const walk = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const topic = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        found.push([topic, join(dir, entry.name)])
        walk(join(dir, entry.name), topic)
      }
    }
    walk(config.evidenceRoot, '')
    return found
  }

  const manifestsOnDisk = (): [string, string][] => {
    const found: [string, string][] = []
    const walk = (dir: string, prefix: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const topic = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const path = join(dir, entry.name, 'manifest.json')
        if (existsSync(path)) found.push([topic, path])
        walk(join(dir, entry.name), topic)
      }
    }
    walk(config.evidenceRoot, '')
    return found
  }

  ctx.tools.register({
    name: 'lg_evidence_add',
    description:
      'Write an evidence manifest binding a claim to the current commit and digest, to its raw files, negatives and controls. In a real environment the plugin runs the command itself and keeps its output as a raw file; a raw file containing a token or key is refused until redacted.',
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
        },
        required: ['path', 'digest', 'commit', 'rawFiles', 'producedByTool'],
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { path?: unknown; digest?: unknown; rawFiles?: unknown; producedByTool?: unknown }
        return [{ type: 'text' as const, text: `manifest ${String(v.path)} at ${String(v.digest)} (${String(v.rawFiles)} raw file(s), tool-produced: ${String(v.producedByTool)})` }]
      },
    },
    async execute(args: unknown, exec: { agent?: unknown }) {
      const input = args as Record<string, unknown>
      const environment = input['environment'] === 'real' ? 'real' : 'simulated'
      const topic = String(input['topic'])
      const command = String(input['command'])
      const cwd = (exec.agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd ?? process.cwd()

      const rawFiles: RawFile[] = []
      let producedByTool = false

      // A real claim needs output this plugin produced itself.
      if (environment === 'real') {
        const run = runCommand(command, cwd)
        const dir = join(config.evidenceRoot, topic, 'raw')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'command-output.txt')
        writeFileSync(file, `${run.stdout}${run.stderr === '' ? '' : `\n--- stderr ---\n${run.stderr}`}`, 'utf8')
        const text = readFileSync(file, 'utf8')
        rawFiles.push({
          path: file,
          sha256: sha(text),
          bytes: Buffer.byteLength(text, 'utf8'),
          producedByTool: {
            command,
            exitCode: run.exitCode,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            hostname: hostname(),
            dshVersion: dshVersion(),
          },
        })
        producedByTool = true
      }

      for (const path of (input['raw'] as unknown[]).map((value) => String(value))) {
        const resolved = resolvePath(cwd, path)
        if (!existsSync(resolved)) throw new Error(`lg_evidence_add: raw file does not exist: ${path}`)
        const text = readFileSync(resolved, 'utf8')
        rawFiles.push({ path: resolved, sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8') })
      }

      // EV-2: a real claim with no tool-produced file is not real evidence.
      if (environment === 'real' && !producedByTool) throw new Error('lg_evidence_add: real evidence needs at least one file produced by running the command')

      // EV-5: refuse to record anything a secret scan flags.
      for (const file of rawFiles) {
        const hits = secretHits(readFileSync(file.path, 'utf8'), config.secretPatterns)
        if (hits.length > 0) throw new Error(`lg_evidence_add: ${file.path} contains ${hits.join(', ')}; redact it before writing the manifest`)
      }

      const manifest: Manifest = {
        topic,
        claim: String(input['claim']),
        environment,
        ...(typeof input['target_environment'] === 'string' ? { targetEnvironment: input['target_environment'] } : {}),
        command,
        commit: digest(),
        digest: digest(),
        raw: rawFiles,
        negativeTests: (input['negative_tests'] as unknown[] | undefined)?.map(String) ?? [],
        controls: (input['controls'] as unknown[] | undefined)?.map(String) ?? [],
        result: String(input['result']),
        writtenAt: new Date().toISOString(),
      }
      mkdirSync(join(config.evidenceRoot, topic), { recursive: true })
      writeFileSync(manifestPath(topic), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      return { path: manifestPath(topic), digest: manifest.digest, commit: manifest.commit, rawFiles: rawFiles.length, producedByTool }
    },
  })

  /** Topics whose manifest no longer matches the current digest. */
  const staleTopics = (): string[] => {
    const current = digest()
    const entries: [string, string][] = manifestsOnDisk().map(([topic, path]) => {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
      return [topic, manifest.digest] as [string, string]
    })
    return staleOf(entries, current)
  }

  // Published so lg-channel can refuse a REPORT that cites a stale manifest
  // (EV-4) without either package importing the other.
  ctx.effect(() => {
    const release = (ctx as unknown as { provide?: (name: string, value: unknown) => () => void }).provide?.('lgEvidence', {
      staleTopics,
      digest,
      // RG-1 condition 3: raw evidence written this turn with no manifest beside it.
      missingManifests: (): string[] => {
        const orphans: string[] = []
        if (!existsSync(config.evidenceRoot)) return orphans
        for (const [topic, dir] of topicsOnDisk()) {
          if (!existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'raw'))) orphans.push(topic)
        }
        return orphans
      },
    })
    return () => release?.()
  })

  ctx.tools.register({
    name: 'lg_evidence_check',
    description: 'Scan every evidence manifest and mark the ones whose digest no longer matches the current one as stale.',
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
              properties: { topic: { type: 'string' }, digest: { type: 'string' }, stale: { type: 'boolean' } },
              required: ['topic', 'digest', 'stale'],
            },
          },
        },
        required: ['current', 'manifests'],
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { current?: unknown; manifests?: { topic: string; stale: boolean }[] }
        const rows = (v.manifests ?? []).map((row) => `${row.stale ? 'STALE' : 'ok'} ${row.topic}`)
        return [{ type: 'text' as const, text: [`current digest ${String(v.current)}`, ...rows].join('\n') }]
      },
    },
    async execute() {
      const current = digest()
      const manifests: ManifestStatus[] = manifestsOnDisk().map(([topic, path]) => {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest
        return { topic, path, digest: manifest.digest, current, stale: manifest.digest !== current }
      })
      return { current, manifests }
    },
  })
}
