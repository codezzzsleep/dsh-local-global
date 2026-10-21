import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { applyPatch } from '../src/patch.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' })

/** A repo with one commit, plus a second commit exported as a patch. */
function repoWithPatch(): { dir: string; patch: Buffer; base: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lg-pa1-'))
  git(dir, 'init', '--quiet', '--initial-branch=main', '.')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@invalid')
  writeFileSync(join(dir, 'note.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'base')
  const base = git(dir, 'rev-parse', 'HEAD').trim()

  writeFileSync(join(dir, 'note.txt'), 'one\ntwo\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'add two')
  const patch = Buffer.from(git(dir, 'format-patch', '--stdout', '-1'), 'utf8')
  // Back to the base so the patch has something to do.
  git(dir, 'reset', '--hard', base)
  return { dir, patch, base, name: '0001-add-two.patch' }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

describe('PA-1: the four outcomes', () => {
  it('APPLIED: a matching patch lands and produces a new commit', () => {
    const { dir, patch, base, name } = repoWithPatch()
    const result = applyPatch({ name, base, bytes: patch.length, sha256: sha256(patch), data: patch }, dir)
    expect(result.verdict).toBe('APPLIED')
    expect(result.commit).toBeDefined()
    expect(result.commit).not.toBe(base)
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it('REJECTED: sha256 that disagrees with the bytes', () => {
    const { dir, patch, base, name } = repoWithPatch()
    const result = applyPatch({ name, base, bytes: patch.length, sha256: 'deadbeef', data: patch }, dir)
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toContain('sha256')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
  })

  it('REJECTED: declared byte count that disagrees, and a missing attachment', () => {
    const { dir, patch, base, name } = repoWithPatch()
    expect(applyPatch({ name, base, bytes: patch.length + 1, sha256: sha256(patch), data: patch }, dir).verdict).toBe('REJECTED')
    expect(applyPatch({ name, base, bytes: patch.length, sha256: sha256(patch) }, dir).verdict).toBe('REJECTED')
  })

  it('DUPLICATE: applying the same patch twice', () => {
    const { dir, patch, base, name } = repoWithPatch()
    const fields = { name, base, bytes: patch.length, sha256: sha256(patch), data: patch }
    expect(applyPatch(fields, dir).verdict).toBe('APPLIED')
    const again = applyPatch(fields, dir)
    expect(again.verdict).toBe('DUPLICATE')
    expect(again.detail).toContain('already applied')
  })

  it('CONFLICT: a patch that cannot apply, leaving the worktree rolled back', () => {
    const { dir, patch, base, name } = repoWithPatch()
    // Move the file away from the patch's expected pre-image.
    writeFileSync(join(dir, 'note.txt'), 'something else entirely\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '--quiet', '-m', 'diverge')
    const before = git(dir, 'rev-parse', 'HEAD').trim()

    const result = applyPatch({ name, base, bytes: patch.length, sha256: sha256(patch), data: patch }, dir)
    expect(result.verdict).toBe('CONFLICT')
    // Rolled back: HEAD unchanged, no in-progress `git am`, file untouched.
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(before)
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('something else entirely\n')
    const am = git(dir, 'status', '--porcelain')
    expect(am).not.toContain('am')
  })

  it('REJECTED: a base that is not an ancestor of HEAD', () => {
    const { dir, patch, name } = repoWithPatch()
    const result = applyPatch({ name, base: '0000000000000000000000000000000000000000', bytes: patch.length, sha256: sha256(patch), data: patch }, dir)
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toContain('not an ancestor')
  })
})
