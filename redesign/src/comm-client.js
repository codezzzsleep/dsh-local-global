/** Client for the communication sandbox. Each role holds its own token. */

export class CommError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'CommError'
    this.status = status
  }
}

export class CommClient {
  constructor({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    this.url = url.replace(/\/+$/, '')
    this.token = token
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  #auth(extra = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra }
  }

  async #json(method, path, body) {
    const response = await this.fetch(`${this.url}${path}`, {
      method,
      headers: this.#auth(body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new CommError(response.status, data.error ?? `HTTP ${response.status}`)
    return data
  }

  /** Publish a message with optional evidence files ({ path, data }). */
  post(message, files = []) {
    return this.#json('POST', '/v1/messages', {
      ...message,
      files: files.map((f) => ({ path: f.path, data: Buffer.from(f.data).toString('base64') })),
    })
  }

  /** Messages addressed to this role. */
  inbox() {
    return this.#json('GET', '/v1/inbox')
  }

  /** Full log; only the human token may read it. */
  log() {
    return this.#json('GET', '/v1/log')
  }

  /** Evidence bytes for a message. The caller must check them against the declared hash. */
  async artifact(id, path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const response = await this.fetch(`${this.url}/v1/messages/${id}/artifacts/${encoded}`, {
      headers: this.#auth(),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new CommError(response.status, data.error ?? `HTTP ${response.status}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
}
