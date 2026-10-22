/**
 * Code sandbox: an internal git host for deliverables. It serves bare
 * repositories over git's smart HTTP protocol, so the executor pushes and the
 * reviewer fetches with ordinary git.
 *
 * Who may do what is decided twice: the HTTP layer checks the role before
 * spawning git, and a per-repository `update` hook checks branch names against
 * REMOTE_USER, which git passes through. History only moves forward
 * (non-fast-forward pushes and deletes are refused).
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { close, HttpError, listen, readBody, roleFor } from './http.js'
import { git } from './git.js'

const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ROUTE_RE = /^\/git\/([a-z0-9][a-z0-9._-]{0,63})\.git(\/[A-Za-z0-9/_.-]*)$/
const WRITERS = new Set(['local', 'human'])
const MAX_PUSH = 200 * 1024 * 1024

const UPDATE_HOOK = `#!/bin/sh
# Branch rules by writer identity. REMOTE_USER is set by the code sandbox.
case "$REMOTE_USER" in
  local)
    case "$1" in
      refs/heads/work/*) exit 0 ;;
      *) echo "executor may only publish to refs/heads/work/*" >&2; exit 1 ;;
    esac ;;
  human) exit 0 ;;
  *) echo "writer not allowed" >&2; exit 1 ;;
esac
`

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Create a bare repository with the sandbox's rules installed. */
export async function createRepo(root, name) {
  if (!REPO_RE.test(name)) throw new Error(`invalid repository name: ${name}`)
  const dir = join(root, `${name}.git`)
  if (await exists(join(dir, 'HEAD'))) throw new Error(`repository already exists: ${name}`)
  await mkdir(root, { recursive: true })
  await git(['init', '--bare', '-q', '--initial-branch', 'main', dir])
  await git(['config', 'http.receivepack', 'true'], { cwd: dir })
  await git(['config', 'receive.denyNonFastForwards', 'true'], { cwd: dir })
  await git(['config', 'receive.denyDeletes', 'true'], { cwd: dir })
  const hook = join(dir, 'hooks', 'update')
  await writeFile(hook, UPDATE_HOOK)
  await chmod(hook, 0o755)
  return dir
}

/** Parse CGI output from git-http-backend into status, headers and body. */
function parseCgi(buffer) {
  let end = buffer.indexOf('\r\n\r\n')
  let sepLength = 4
  if (end < 0) {
    end = buffer.indexOf('\n\n')
    sepLength = 2
  }
  if (end < 0) return { status: 500, headers: { 'content-type': 'text/plain' }, body: Buffer.from('bad backend output\n') }
  let status = 200
  const headers = {}
  for (const line of buffer.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'status') status = parseInt(value, 10)
    else headers[key] = value
  }
  return { status, headers, body: buffer.subarray(end + sepLength) }
}

function runBackend({ root, name, rest, req, url, role, body }) {
  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${name}.git${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(body.length),
      REMOTE_USER: role,
      REMOTE_ADDR: req.socket.remoteAddress ?? '',
    }
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol']
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding']

    const child = spawn('git', ['http-backend'], { env })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', () => resolve(parseCgi(Buffer.concat(chunks))))
    child.stdin.end(body)
  })
}

/**
 * @param {{ root: string, tokens: Map<string, string> }} config  tokens maps token -> role
 */
export function createCodeSandbox({ root, tokens }) {
  async function handle(req, res) {
    const role = roleFor(req, tokens)
    if (!role) throw new HttpError(401, 'unauthorized')

    const url = new URL(req.url, 'http://sandbox')
    const match = url.pathname.match(ROUTE_RE)
    if (!match) throw new HttpError(404, 'not found')
    const [, name, rest] = match
    if (!(await exists(join(root, `${name}.git`, 'HEAD')))) throw new HttpError(404, 'no such repository')

    const service = url.searchParams.get('service')
    let writing
    if (req.method === 'GET' && rest === '/info/refs' && service === 'git-upload-pack') writing = false
    else if (req.method === 'GET' && rest === '/info/refs' && service === 'git-receive-pack') writing = true
    else if (req.method === 'POST' && rest === '/git-upload-pack') writing = false
    else if (req.method === 'POST' && rest === '/git-receive-pack') writing = true
    else throw new HttpError(404, 'unsupported operation (smart git protocol only)')
    if (writing && !WRITERS.has(role)) throw new HttpError(403, `role ${role} is read-only on code repositories`)

    const body = req.method === 'POST' ? await readBody(req, MAX_PUSH) : Buffer.alloc(0)
    const result = await runBackend({ root, name, rest, req, url, role, body })
    res.writeHead(result.status, result.headers)
    res.end(result.body)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) {
        res.writeHead(error.status, { 'content-type': 'text/plain' })
        return res.end(`${error.message}\n`)
      }
      console.error('code sandbox error:', error)
      res.writeHead(500, { 'content-type': 'text/plain' })
      return res.end('internal error\n')
    })
  })

  return {
    server,
    listen: (port) => listen(server, port),
    close: () => close(server),
  }
}
