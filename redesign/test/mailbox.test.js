import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { Mailbox, unseen } from '../src/mailbox.js'
import { ProtocolError, validateMessage } from '../src/protocol.js'
import { scratch } from './helpers.js'

test('posted messages are listed oldest first and get valid ids', async () => {
  const mailbox = new Mailbox(join(await scratch('mb'), 'mailbox'))
  const a = await mailbox.post({ from: 'local', to: 'global', kind: 'report', summary: 'first' })
  const b = await mailbox.post({ from: 'local', to: 'global', kind: 'report', summary: 'second' })
  const listed = await mailbox.list()
  assert.deepEqual(listed.map((m) => m.summary), ['first', 'second'])
  assert.match(a.record.id, /^\d{15}-[0-9a-f]{8}$/)
  assert.ok(b.record.id > a.record.id)
})

test('posting the same id twice is a no-op', async () => {
  const mailbox = new Mailbox(join(await scratch('mb'), 'mailbox'))
  const first = await mailbox.post({ from: 'human', to: 'local', kind: 'task', summary: 'do it' })
  const again = await mailbox.post({ id: first.record.id, from: 'human', to: 'local', kind: 'task', summary: 'do it' })
  assert.equal(again.created, false)
  assert.equal((await mailbox.list()).length, 1)
})

test('role and kind rules are enforced', () => {
  assert.throws(
    () => validateMessage({ from: 'local', to: 'global', kind: 'directive', summary: 'x' }),
    ProtocolError,
  )
  assert.throws(
    () => validateMessage({ from: 'global', to: 'local', kind: 'verdict', summary: 'x' }),
    /must name the message it judges/,
  )
  assert.throws(
    () => validateMessage({ from: 'local', to: 'global', kind: 'report', summary: '   ' }),
    /summary is required/,
  )
})

test('ids that could escape the messages directory are rejected', async () => {
  const mailbox = new Mailbox(join(await scratch('mb'), 'mailbox'))
  await assert.rejects(mailbox.get('../../etc/passwd'), /invalid message id/)
  assert.throws(() => mailbox.artifactsDir('..'), /invalid message id/)
})

test('unseen returns each message once, and only after commit', async () => {
  const root = await scratch('mb')
  const mailbox = new Mailbox(join(root, 'mailbox'))
  const cursor = join(root, 'cursor.json')
  await mailbox.post({ from: 'local', to: 'global', kind: 'report', summary: 'r1' })

  const first = await unseen(mailbox, cursor, (m) => m.to === 'global')
  assert.equal(first.fresh.length, 1)

  // Not committed yet: a failed reader sees the same item again.
  const retry = await unseen(mailbox, cursor, (m) => m.to === 'global')
  assert.equal(retry.fresh.length, 1)

  await retry.commit()
  const after = await unseen(mailbox, cursor, (m) => m.to === 'global')
  assert.equal(after.fresh.length, 0)
})

test('a corrupt message file in the mailbox is reported, not silently skipped', async () => {
  const root = await scratch('mb')
  const mailbox = new Mailbox(join(root, 'mailbox'))
  await mailbox.init()
  await writeFile(join(mailbox.messagesDir, '000000000000001-deadbeef.json'), '{not json')
  await assert.rejects(mailbox.list(), SyntaxError)
})
