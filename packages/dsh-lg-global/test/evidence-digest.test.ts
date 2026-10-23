import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveEvidenceConfig, versionState } from '../../dsh-lg-local/src/evidence.js'
import { treeDigestAt } from '../src/evidence-check.js'
import { createWorld, git, type World } from './m4-world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(async () => {
  await w.close()
})

/** Local's digest of its clean worktree, and Global's digest of the same commit read from the mirror. */
async function both(evidenceRoot = 'evidence'): Promise<{ local: string; global: string; commit: string }> {
  const commit = await git(w.work, 'rev-parse', 'HEAD')
  await w.sync()
  const state = versionState(resolveEvidenceConfig({ evidenceRoot: join(w.work, evidenceRoot) }, w.work), w.work)
  expect(state.dirty).toBe(false)
  expect(state.commit).toBe(commit)
  return { local: state.digest, global: await treeDigestAt(join(w.root, 'mirror.git'), commit, evidenceRoot), commit }
}

const listing = (dir: string): string[] => {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(`${relative(dir, path)}:${String(statSync(path).size)}`)
    }
  }
  walk(dir)
  return out.sort()
}

describe('GD-3: the Global-side digest is the one Local computes (git:tree of a clean worktree)', () => {
  it('equals the commit tree when there is no evidence directory yet', async () => {
    const { local, global, commit } = await both()
    expect(global).toBe(local)
    expect(global).toBe(await git(w.work, 'rev-parse', `${commit}^{tree}`))
  })

  it('equals Local\'s with evidence present, and ignores evidence-only changes on both sides', async () => {
    await w.commit({ 'evidence/M4/a/manifest.json': '{"x":1}\n', 'evidence/M4/a/raw/out.txt': 'out\n', 'evidence-notes/keep.txt': 'not evidence\n' }, 'evidence')
    const first = await both()
    expect(first.global).toBe(first.local)
    // The digest is the tree minus the evidence root, so it differs from the commit's own tree...
    expect(first.global).not.toBe(await git(w.work, 'rev-parse', `${first.commit}^{tree}`))

    await w.commit({ 'evidence/M4/a/manifest.json': '{"x":2}\n', 'evidence/M4/b/manifest.json': '{}\n' }, 'more evidence')
    const second = await both()
    expect(second.global).toBe(second.local)
    expect(second.global).toBe(first.global)

    await w.commit({ 'src/a.txt': 'changed\n' }, 'code')
    const third = await both()
    expect(third.global).toBe(third.local)
    expect(third.global).not.toBe(first.global)
  })

  it('follows a nested evidence root and does not exclude a sibling with the same prefix', async () => {
    await w.commit({ 'docs/evidence/m4/manifest.json': '{}\n', 'docs/evidence-other/file.txt': 'x\n' }, 'nested')
    const nested = await both('docs/evidence')
    expect(nested.global).toBe(nested.local)
    await w.commit({ 'docs/evidence-other/file.txt': 'y\n' }, 'sibling')
    const moved = await both('docs/evidence')
    expect(moved.global).toBe(moved.local)
    expect(moved.global).not.toBe(nested.global)
  })

  it('writes no object into the mirror and leaves no scratch directory behind', async () => {
    await w.commit({ 'evidence/M4/a/manifest.json': '{}\n' }, 'evidence')
    const commit = await git(w.work, 'rev-parse', 'HEAD')
    await w.sync()
    const mirrorDir = join(w.root, 'mirror.git')
    const before = listing(mirrorDir)
    const scratch = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('lg-digest-'))
    const scratchBefore = scratch()
    await treeDigestAt(mirrorDir, commit, 'evidence')
    expect(listing(mirrorDir)).toEqual(before)
    expect(scratch()).toEqual(scratchBefore)
  })

  it('refuses anything but a full commit id', async () => {
    await expect(treeDigestAt(join(w.root, 'mirror.git'), 'HEAD', 'evidence')).rejects.toThrow(/full commit id/)
  })
})
