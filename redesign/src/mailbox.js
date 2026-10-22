/**
 * The mailbox is a shared directory:
 *
 *   <mailbox>/messages/<id>.json      one immutable file per message
 *   <mailbox>/artifacts/<id>/...      evidence copied in with its message
 *
 * Either side can run without the other. Writes are atomic renames, so a
 * reader never sees a half-written message, and posting an existing id is a
 * no-op, which makes retries safe.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newId } from './ids.js'
import { ID_RE, validateMessage } from './protocol.js'
import { exists, readJson, writeJsonAtomic } from './fsutil.js'

export function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`invalid message id: ${JSON.stringify(id)}`)
  }
  return id
}

export class Mailbox {
  constructor(dir) {
    this.dir = dir
  }

  get messagesDir() {
    return join(this.dir, 'messages')
  }

  artifactsDir(id) {
    return join(this.dir, 'artifacts', assertId(id))
  }

  async init() {
    await mkdir(this.messagesDir, { recursive: true })
    await mkdir(join(this.dir, 'artifacts'), { recursive: true })
  }

  /**
   * Validate and publish a message. Returns `{ record, created }`; `created`
   * is false when a message with the same id already exists.
   */
  async post(message) {
    validateMessage(message)
    const id = message.id ?? newId()
    assertId(id)
    const record = {
      ...message,
      id,
      created_at: message.created_at ?? new Date().toISOString(),
      artifacts: message.artifacts ?? [],
    }
    const file = join(this.messagesDir, `${id}.json`)
    if (await exists(file)) return { record, created: false }

    await this.init()
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    await rename(tmp, file)
    return { record, created: true }
  }

  /** Every message, oldest first. A missing mailbox is empty, not an error. */
  async list() {
    let names
    try {
      names = await readdir(this.messagesDir)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const messages = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      messages.push(JSON.parse(await readFile(join(this.messagesDir, name), 'utf8')))
    }
    return messages
  }

  async get(id) {
    assertId(id)
    try {
      return JSON.parse(await readFile(join(this.messagesDir, `${id}.json`), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
}

/**
 * Messages matching `predicate` that this reader has not yet committed.
 * Nothing is marked seen until `commit()` runs, so a reader that fails halfway
 * sees the same items again next time (at-least-once delivery).
 */
export async function unseen(mailbox, cursorFile, predicate) {
  const seen = new Set((await readJson(cursorFile, { seen: [] })).seen)
  const fresh = (await mailbox.list()).filter((m) => !seen.has(m.id) && predicate(m))
  return {
    fresh,
    async commit() {
      for (const m of fresh) seen.add(m.id)
      await writeJsonAtomic(cursorFile, { seen: [...seen] })
    },
  }
}
