/**
 * Communication sandbox: the message channel between the executor, the
 * reviewer and the human. It replaces the public channel when none exists.
 *
 * Every request is authenticated with a per-role token, and the role comes
 * from the token, never from the body. The server checks who may send what
 * (see protocol.js), stores evidence and its hashes, and hands each role only
 * what is addressed to it.
 */
import { createServer } from 'node:http'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeRelative, sha256 } from './artifacts.js'
import { close, HttpError, json, listen, readBody, roleFor } from './http.js'
import { newId } from './ids.js'
import { Mailbox } from './mailbox.js'
import { LIMITS, ProtocolError, validateMessage } from './protocol.js'

const MAX_BODY = 40 * 1024 * 1024
const ARTIFACT_RE = /^\/v1\/messages\/(\d{15}-[0-9a-f]{8})\/artifacts\/(.+)$/

/** Fields a sender may set. Anything else in the body is ignored. */
const WRITABLE = [
  'kind', 'to', 'summary', 'body', 'status', 'verdict', 're', 'findings',
  'acceptance', 'commit', 'published_branch', 'dirty', 'client_id',
]

function decodePath(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'bad path encoding')
  }
}

function parseFiles(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'files must be an array')
  if (value.length > LIMITS.artifacts) throw new HttpError(400, `too many files (limit ${LIMITS.artifacts})`)
  const seen = new Set()
  return value.map((file) => {
    let path
    try {
      path = safeRelative(file?.path)
    } catch (error) {
      throw new HttpError(400, error.message)
    }
    if (seen.has(path)) throw new HttpError(400, `duplicate file: ${path}`)
    seen.add(path)
    if (typeof file.data !== 'string') throw new HttpError(400, `file ${path} has no data`)
    const data = Buffer.from(file.data, 'base64')
    if (data.length > LIMITS.artifactBytes) throw new HttpError(413, `file ${path} is too large`)
    return { path, data }
  })
}

/** Write evidence into place in one step: stage in `.partial`, then rename. */
async function storeFiles(dir, files) {
  if (files.length === 0) return []
  const partial = `${dir}.partial`
  await rm(partial, { recursive: true, force: true })
  for (const file of files) {
    const dest = join(partial, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.data)
  }
  await mkdir(dirname(dir), { recursive: true })
  await rename(partial, dir)
  return files.map((f) => ({ path: f.path, sha256: sha256(f.data), bytes: f.data.length }))
}

/**
 * @param {{ dir: string, tokens: Map<string, string> }} config  tokens maps token -> role
 */
export function createCommSandbox({ dir, tokens }) {
  const mailbox = new Mailbox(dir)

  async function post(role, req, res) {
    const raw = await readBody(req, MAX_BODY)
    let input
    try {
      input = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new HttpError(400, 'body must be JSON')
    }
    if (typeof input !== 'object' || input === null) throw new HttpError(400, 'body must be an object')

    const fields = {}
    for (const key of WRITABLE) if (input[key] !== undefined) fields[key] = input[key]
    const message = { ...fields, from: role }

    // Retries of the same send return the original message instead of a copy.
    if (fields.client_id !== undefined) {
      const existing = (await mailbox.list()).find((m) => m.from === role && m.client_id === fields.client_id)
      if (existing) return json(res, 200, { id: existing.id, duplicate: true })
    }

    try {
      validateMessage({ ...message, artifacts: [] })
    } catch (error) {
      if (error instanceof ProtocolError) return json(res, 400, { error: error.message, errors: error.errors })
      throw error
    }

    const files = parseFiles(input.files)
    const id = newId()
    const artifacts = await storeFiles(mailbox.artifactsDir(id), files)
    const { record } = await mailbox.post({ ...message, id, artifacts })
    return json(res, 201, {
      id: record.id,
      artifacts: record.artifacts.map((a) => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
    })
  }

  async function inbox(role, res) {
    const messages = (await mailbox.list()).filter((m) => m.to === role)
    return json(res, 200, { messages })
  }

  async function fullLog(role, res) {
    if (role !== 'human') throw new HttpError(403, 'only the human may read the full log')
    return json(res, 200, { messages: await mailbox.list() })
  }

  async function artifact(role, id, rawPath, res) {
    if (role === 'local') throw new HttpError(403, 'the executor reads its own workspace, not the sandbox')
    const message = await mailbox.get(id)
    if (!message) throw new HttpError(404, 'no such message')
    if (role === 'global' && message.to !== 'global') {
      throw new HttpError(403, 'this message is not addressed to the reviewer')
    }
    let rel
    try {
      rel = safeRelative(decodePath(rawPath))
    } catch (error) {
      throw new HttpError(400, error.message)
    }
    const entry = message.artifacts.find((a) => a.path === rel)
    if (!entry) throw new HttpError(404, 'no such artifact on this message')

    let data
    try {
      data = await readFile(join(mailbox.artifactsDir(id), rel))
    } catch {
      throw new HttpError(404, 'artifact is missing from storage')
    }
    if (sha256(data) !== entry.sha256) throw new HttpError(409, 'stored content does not match its recorded hash')
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
    res.end(data)
  }

  async function route(req, res) {
    const role = roleFor(req, tokens)
    if (!role) throw new HttpError(401, 'unauthorized')
    const url = new URL(req.url, 'http://sandbox')
    if (req.method === 'POST' && url.pathname === '/v1/messages') return post(role, req, res)
    if (req.method === 'GET' && url.pathname === '/v1/inbox') return inbox(role, res)
    if (req.method === 'GET' && url.pathname === '/v1/log') return fullLog(role, res)
    const match = url.pathname.match(ARTIFACT_RE)
    if (req.method === 'GET' && match) return artifact(role, match[1], match[2], res)
    throw new HttpError(404, 'not found')
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message, ...error.extra })
      console.error('communication sandbox error:', error)
      return json(res, 500, { error: 'internal error' })
    })
  })

  return {
    server,
    listen: (port) => listen(server, port),
    close: () => close(server),
  }
}

