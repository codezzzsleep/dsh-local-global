import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { startStack } from './helpers.js'
import { CommError } from '../src/comm-client.js'

const stacks = []
after(async () => Promise.all(stacks.map((s) => s.close())))

async function stack(label) {
  const s = await startStack(label)
  stacks.push(s)
  return s
}

test('requests without a known token are refused', async () => {
  const s = await stack('comm-auth')
  const res = await fetch(`${s.commUrl}/v1/inbox`)
  assert.equal(res.status, 401)
  const bad = await fetch(`${s.commUrl}/v1/inbox`, { headers: { authorization: 'Bearer nope' } })
  assert.equal(bad.status, 401)
})

test('the sender role comes from the token, never from the body', async () => {
  const s = await stack('comm-from')
  const local = s.client('local')
  const { id } = await local.post({ kind: 'report', to: 'global', summary: 'hi', from: 'global' })
  const { messages } = await s.client('global').inbox()
  const stored = messages.find((m) => m.id === id)
  assert.equal(stored.from, 'local')
})

test('role rules hold on the server: the executor cannot send a directive', async () => {
  const s = await stack('comm-rules')
  await assert.rejects(
    s.client('local').post({ kind: 'directive', to: 'local', summary: 'I order myself' }),
    (error) => error instanceof CommError && error.status === 400 && /cannot be sent by local/.test(error.message),
  )
})

test('each role only sees messages addressed to it', async () => {
  const s = await stack('comm-inbox')
  await s.client('local').post({ kind: 'report', to: 'global', summary: 'done a thing' })
  await s.client('global').post({ kind: 'directive', to: 'local', summary: 'do the next thing' })

  const local = await s.client('local').inbox()
  assert.deepEqual(local.messages.map((m) => m.summary), ['do the next thing'])
  const global = await s.client('global').inbox()
  assert.deepEqual(global.messages.map((m) => m.summary), ['done a thing'])
})

test('a retried send with the same client_id returns the original message', async () => {
  const s = await stack('comm-dedupe')
  const report = await s.client('local').post({ kind: 'report', to: 'global', summary: 'r' })
  const a = await s.client('global').post({ kind: 'verdict', to: 'local', re: report.id, verdict: 'accepted', summary: 'ok', client_id: 'batch:0' })
  const b = await s.client('global').post({ kind: 'verdict', to: 'local', re: report.id, verdict: 'accepted', summary: 'ok', client_id: 'batch:0' })
  assert.equal(b.id, a.id)
  assert.equal(b.duplicate, true)
  const { messages } = await s.client('human').log()
  assert.equal(messages.filter((m) => m.kind === 'verdict').length, 1)
})

test('evidence is stored with hashes and only the addressed reviewer can read it', async () => {
  const s = await stack('comm-evidence')
  const bytes = Buffer.from('test output: 12 passed\n')
  const { id, artifacts } = await s.client('local').post(
    { kind: 'report', to: 'global', summary: 'tests', client_id: 'r1' },
    [{ path: 'logs/test.txt', data: bytes }],
  )
  assert.equal(artifacts[0].path, 'logs/test.txt')
  assert.equal(artifacts[0].bytes, bytes.length)

  const fetched = await s.client('global').artifact(id, 'logs/test.txt')
  assert.deepEqual(fetched, bytes)

  await assert.rejects(s.client('local').artifact(id, 'logs/test.txt'), (e) => e.status === 403)
  await assert.rejects(s.client('global').artifact(id, '../../etc/passwd'), (e) => e.status === 400 || e.status === 404)
  await assert.rejects(s.client('global').artifact(id, 'not/declared.txt'), (e) => e.status === 404)
})

test('stored evidence that changes on disk is refused, not served', async () => {
  const s = await stack('comm-tamper')
  const { id } = await s.client('local').post(
    { kind: 'report', to: 'global', summary: 'tests', client_id: 'r2' },
    [{ path: 'out.txt', data: Buffer.from('original') }],
  )
  await writeFile(join(s.root, 'comm', 'artifacts', id, 'out.txt'), 'forged')
  await assert.rejects(s.client('global').artifact(id, 'out.txt'), (e) => e.status === 409)
  assert.equal(await readFile(join(s.root, 'comm', 'artifacts', id, 'out.txt'), 'utf8'), 'forged')
})

test('only the human may read the full log', async () => {
  const s = await stack('comm-log')
  await assert.rejects(s.client('global').log(), (e) => e.status === 403)
  await assert.rejects(s.client('local').log(), (e) => e.status === 403)
  const { messages } = await s.client('human').log()
  assert.ok(Array.isArray(messages))
})

test('oversized evidence is refused', async () => {
  const s = await stack('comm-size')
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a')
  await assert.rejects(
    s.client('local').post({ kind: 'report', to: 'global', summary: 'big' }, [{ path: 'big.bin', data: big }]),
    (e) => e.status === 413 || e.status === 400,
  )
})
