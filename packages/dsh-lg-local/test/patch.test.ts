import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

describe('PA-1: the worktree is never harmed', () => {
  const fieldsOf = (patch: Buffer, base: string, name: string) => ({ name, base, bytes: patch.length, sha256: sha256(patch), data: patch })

  it('refuses a dirty worktree, whatever the patch would do, and leaves the dirt alone', () => {
    const { dir, patch, base, name } = repoWithPatch()
    writeFileSync(join(dir, 'note.txt'), 'my uncommitted edit\n')
    writeFileSync(join(dir, 'scratch.txt'), 'untracked work\n')
    const result = applyPatch(fieldsOf(patch, base, name), dir)
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toMatch(/uncommitted.*note\.txt/)
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('my uncommitted edit\n')
    expect(readFileSync(join(dir, 'scratch.txt'), 'utf8')).toBe('untracked work\n')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
  })

  it('a conflict on a clean tree restores HEAD, index and files, and leaves no am in progress', () => {
    const { dir, patch, base, name } = repoWithPatch()
    // Same line, different change: `git am --3way` stops with conflict markers in the file.
    writeFileSync(join(dir, 'note.txt'), 'uno\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '--quiet', '-m', 'diverge on the same line')
    const before = git(dir, 'rev-parse', 'HEAD').trim()
    const result = applyPatch(fieldsOf(patch, base, name), dir)
    expect(result.verdict).toBe('CONFLICT')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(before)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('uno\n')
    expect(existsSync(join(dir, '.git', 'rebase-apply'))).toBe(false)
  })

  it('does not call a non-mbox attachment or a missing git identity a conflict', () => {
    const { dir, base, name } = repoWithPatch()
    const text = Buffer.from('this is not a patch\n')
    const notMbox = applyPatch(fieldsOf(text, base, name), dir)
    expect(notMbox).toMatchObject({ verdict: 'REJECTED' })
    expect(notMbox.detail).toContain('not a git format-patch')

    const bare = repoWithPatch()
    git(bare.dir, 'config', '--unset', 'user.name')
    git(bare.dir, 'config', '--unset', 'user.email')
    git(bare.dir, 'config', 'user.useConfigOnly', 'true')
    const saved = process.env['GIT_CONFIG_GLOBAL']
    process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
    try {
      const result = applyPatch(fieldsOf(bare.patch, bare.base, bare.name), bare.dir)
      expect(result.verdict).toBe('REJECTED')
      expect(result.detail).toContain('identity')
    } finally {
      if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']
      else process.env['GIT_CONFIG_GLOBAL'] = saved
    }
    expect(git(bare.dir, 'status', '--porcelain')).toBe('')
  })

  it('reports a git failure that is not a conflict as REJECTED and restores the worktree', () => {
    const { dir, patch, base, name } = repoWithPatch()
    // The applypatch-msg hook refuses: `git am` stops without any conflict.
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(dir, '.git', 'hooks', 'applypatch-msg'), '#!/bin/sh\necho refused by hook >&2\nexit 1\n', { mode: 0o755 })
    const result = applyPatch(fieldsOf(patch, base, name), dir)
    expect(result.verdict).toBe('REJECTED')
    expect(result.detail).toContain('other than a conflict')
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
    expect(existsSync(join(dir, '.git', 'rebase-apply'))).toBe(false)
  })

  it('refuses while a git am is already in progress', () => {
    const { dir, patch, base, name } = repoWithPatch()
    mkdirSync(join(dir, '.git', 'rebase-apply'))
    const result = applyPatch(fieldsOf(patch, base, name), dir)
    expect(result).toMatchObject({ verdict: 'REJECTED' })
    expect(result.detail).toContain('in progress')
  })

  it('refuses a directory that is not a worktree', () => {
    const { patch, base, name } = repoWithPatch()
    const result = applyPatch(fieldsOf(patch, base, name), mkdtempSync(join(tmpdir(), 'lg-nogit-')))
    expect(result).toMatchObject({ verdict: 'REJECTED' })
  })

  it('never lets the patch name reach the file system', () => {
    const { dir, patch, base } = repoWithPatch()
    for (const name of ['../x', '../../x.patch', 'a/b.patch', '.hidden', '']) {
      expect(applyPatch(fieldsOf(patch, base, name), dir).verdict).toBe('REJECTED')
    }
    expect(existsSync(join(tmpdir(), 'x.patch'))).toBe(false)
    expect(existsSync(join(tmpdir(), 'x'))).toBe(false)
    // A plain name still works.
    expect(applyPatch(fieldsOf(patch, base, 'ok-1.patch'), dir).verdict).toBe('APPLIED')
  })
})
