import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { readEvidence, safeRelative, sha256 } from '../src/artifacts.js'
import { scratch } from './helpers.js'

test('safeRelative keeps paths inside their root', () => {
  assert.equal(safeRelative('a/b.txt'), 'a/b.txt')
  assert.equal(safeRelative('./a/../a/b.txt'), 'a/b.txt')
  assert.throws(() => safeRelative('../secret'), /escapes/)
  assert.throws(() => safeRelative('a/../../secret'), /escapes/)
  assert.throws(() => safeRelative('/etc/passwd'), /must be relative/)
  assert.throws(() => safeRelative('~/x'), /must be relative/)
  assert.throws(() => safeRelative('a\0b'), /invalid path/)
})

test('readEvidence returns the bytes and their hash', async () => {
  const root = await scratch('evidence')
  const workspace = join(root, 'ws')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await writeFile(join(workspace, 'out', 'result.txt'), 'pass\n')

  const [entry] = await readEvidence({ workspace, paths: ['out/result.txt'] })
  assert.equal(entry.path, 'out/result.txt')
  assert.equal(entry.bytes, 5)
  assert.equal(entry.data.toString('utf8'), 'pass\n')
  assert.equal(entry.sha256, sha256(Buffer.from('pass\n')))
})

test('readEvidence refuses paths outside the workspace and symlinks that point out', async () => {
  const root = await scratch('evidence-escape')
  const workspace = join(root, 'ws')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(root, 'secret.txt'), 'top secret')
  await symlink(join(root, 'secret.txt'), join(workspace, 'link.txt'))

  await assert.rejects(readEvidence({ workspace, paths: ['../secret.txt'] }), /escapes/)
  await assert.rejects(readEvidence({ workspace, paths: ['link.txt'] }), /escapes the workspace/)
})

test('readEvidence reports missing files and enforces the count limit', async () => {
  const root = await scratch('evidence-missing')
  const workspace = join(root, 'ws')
  await mkdir(workspace, { recursive: true })
  await assert.rejects(readEvidence({ workspace, paths: ['nope.txt'] }), /evidence not found: nope.txt/)
  const tooMany = Array.from({ length: 21 }, (_, i) => `f${i}.txt`)
  await assert.rejects(readEvidence({ workspace, paths: tooMany }), /too many/)
})
