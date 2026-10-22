/** Small HTTP helpers shared by the communication and code sandboxes. */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length })
  res.end(data)
}

/** Read the whole body, refusing anything over `limit` bytes. */
export async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * The bearer token from `Authorization: Bearer <t>`, or the password from
 * `Authorization: Basic ...` (what git sends for HTTP credentials).
 */
export function tokenFrom(req) {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    return colon >= 0 ? decoded.slice(colon + 1) : decoded
  }
  return null
}

/** Map a request to a role through a token table (Map of token -> role). */
export function roleFor(req, tokens) {
  const token = tokenFrom(req)
  return token !== null && tokens.has(token) ? tokens.get(token) : null
}

export function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      resolve(`http://${host}:${server.address().port}`)
    })
  })
}

export function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}
