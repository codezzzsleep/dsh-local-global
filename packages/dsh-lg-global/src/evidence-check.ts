/**
 * What `lg_stop` checks about the evidence a STOP cites.
 *
 * Global has no shell and cannot run anything, so it can only judge manifests
 * Local committed. A manifest proves a claim for exactly one version, named by
 * its `digest`: the git tree of the worktree *without the evidence root*
 * (`git:tree` in dsh-lg-local `evidence.ts`). For a clean worktree that is the
 * tree of the commit minus the evidence directory, which is computed here with
 * git itself and without writing a single object into the mirror.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError, checkRepoPath, runGit, runGitBytes } from './repo.js'

const SHA = /^[0-9a-f]{40}$/u

/**
 * The `git:tree` digest of a commit, as Local computes it for a clean worktree.
 *
 * The commit's tree is read into a throwaway index, the evidence root is
 * dropped, and the tree is written into a scratch object directory that has the
 * mirror as an alternate, so the mirror itself stays untouched.
 * @param mirrorDir - the bare mirror.
 * @param commit - a full commit id.
 * @param evidenceRoot - repository-relative evidence root, no glob characters.
 * @returns the tree id.
 */
export async function treeDigestAt(mirrorDir: string, commit: string, evidenceRoot: string): Promise<string> {
  if (!SHA.test(commit)) throw new TypeError('treeDigestAt: commit must be a full commit id')
  const scratch = await mkdtemp(join(tmpdir(), 'lg-digest-'))
  try {
    const objects = join(scratch, 'objects')
    const workTree = join(scratch, 'worktree')
    await mkdir(objects)
    await mkdir(workTree)
    const env = {
      GIT_DIR: mirrorDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(mirrorDir, 'objects'),
    }
    await runGit(['read-tree', '--end-of-options', commit], { cwd: scratch, env })
    // Same removal Local performs; -f because the scratch index is not the checked-out HEAD.
    await runGit(['rm', '-r', '--cached', '-f', '-q', '--ignore-unmatch', '--', evidenceRoot], { cwd: scratch, env })
    return (await runGit(['write-tree'], { cwd: scratch, env })).stdout.trim()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** A blob at a commit, or undefined when the path is not there. */
async function blobAt(mirrorDir: string, commit: string, path: string): Promise<Buffer | undefined> {
  try {
    return (await runGitBytes(['cat-file', 'blob', `${commit}:${path}`], { cwd: mirrorDir })).stdout
  } catch (error) {
    if (error instanceof GitError) return undefined
    throw error
  }
}

/** The parts of a manifest this check reads; the rest is Local's business. */
interface ManifestLike {
  readonly environment?: unknown
  readonly digest?: unknown
  readonly digestKind?: unknown
  readonly worktreeDirty?: unknown
  readonly raw?: unknown
}

/** A path made only of plain segments, so `<evidence root>/<rel>` cannot leave the root. */
function plainRelative(path: string): boolean {
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Why one cited manifest does not prove its criterion at `commit`.
 * @param input - the mirror, the commit, the manifest path, the commit's digest, and the evidence root.
 * @returns the reasons; empty means the manifest is acceptable.
 */
export async function manifestProblems(input: { mirrorDir: string; commit: string; path: string; digest: string; evidenceRoot: string }): Promise<string[]> {
  const { mirrorDir, commit, path, digest, evidenceRoot } = input
  try {
    checkRepoPath(path, 'evidence path')
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  if (!plainRelative(path) || !path.startsWith(`${evidenceRoot}/`) || !path.endsWith('/manifest.json')) {
    return [`not a manifest: expected ${evidenceRoot}/<topic>/manifest.json`]
  }
  const bytes = await blobAt(mirrorDir, commit, path)
  if (bytes === undefined) return [`no such manifest at ${commit.slice(0, 12)}`]
  let manifest: ManifestLike
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    manifest = parsed as ManifestLike
  } catch (error) {
    return [`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
  }

  const problems: string[] = []
  if (manifest.environment !== 'real') problems.push(`environment is ${JSON.stringify(manifest.environment)}, only "real" evidence counts`)
  if (manifest.worktreeDirty !== false) problems.push('the manifest was written on a dirty worktree, or does not say it was clean')
  if (manifest.digestKind !== 'tree') problems.push(`digestKind is ${JSON.stringify(manifest.digestKind)}; only git:tree digests can be checked from the mirror`)
  else if (manifest.digest !== digest) problems.push(`stale: the manifest is for ${String(manifest.digest)}, the code at ${commit.slice(0, 12)} is ${digest}`)

  const raw = Array.isArray(manifest.raw) ? (manifest.raw as unknown[]) : []
  if (raw.length === 0) problems.push('the manifest lists no raw files')
  let produced = false
  for (const entry of raw) {
    const file = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
    const rel = file['rel']
    if (typeof rel !== 'string' || !plainRelative(rel)) {
      problems.push(`raw file has no usable "rel" path inside the evidence root: ${JSON.stringify(file['path'] ?? rel)}`)
      continue
    }
    if (typeof file['producedByTool'] === 'object' && file['producedByTool'] !== null) produced = true
    const blob = await blobAt(mirrorDir, commit, `${evidenceRoot}/${rel}`)
    if (blob === undefined) {
      problems.push(`raw file missing at ${commit.slice(0, 12)}: ${rel}`)
      continue
    }
    if (createHash('sha256').update(blob).digest('hex') !== file['sha256']) problems.push(`raw file changed since the manifest: ${rel}`)
    if (typeof file['bytes'] === 'number' && file['bytes'] !== blob.length) problems.push(`raw file size differs from the manifest: ${rel}`)
  }
  if (raw.length > 0 && !produced) problems.push('no raw file was produced by the tool itself, so the run is not shown to have happened')
  return problems
}
