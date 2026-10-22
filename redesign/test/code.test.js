import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { startStack, commit } from './helpers.js'

const run = promisify(execFile)
const stacks = []
after(async () => Promise.all(stacks.map((s) => s.close())))

async function stack(label) {
  const s = await startStack(label)
  stacks.push(s)
  return s
}

/** Run git against the code sandbox with one role's token, in a scratch clone. */
function gitAs(token, cwd, args) {
  return run('git', ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args], { cwd }).then(
    (r) => ({ ok: true, out: r.stdout + r.stderr }),
    (e) => ({ ok: false, out: `${e.stderr ?? ''}${e.stdout ?? ''}` }),
  )
}

test('the code sandbox refuses anonymous access', async () => {
  const s = await stack('code-anon')
  const dir = join(s.root, 'anon-clone')
  const result = await run('git', ['clone', '-q', s.repoUrl, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(
    () => 'cloned',
    () => 'refused',
  )
  assert.equal(result, 'refused')
})

test('global can read the repository but cannot push to it', async () => {
  const s = await stack('code-global')
  const workspace = s.workspace
  await commit(workspace, 'a.txt', 'a\n', 'add a')
  const pushed = await gitAs(s.tokens.local, workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/main'])
  assert.equal(pushed.ok, true, pushed.out)

  const clone = join(s.root, 'global-clone')
  const cloned = await gitAs(s.tokens.global, s.root, ['clone', '-q', s.repoUrl, clone])
  assert.equal(cloned.ok, true, cloned.out)

  await writeFile(join(clone, 'evil.txt'), 'x\n')
  await run('git', ['-C', clone, 'add', '.'])
  await run('git', ['-C', clone, '-c', 'user.email=g@x', '-c', 'user.name=g', 'commit', '-qm', 'sneaky'])
  const push = await gitAs(s.tokens.global, clone, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/sneaky'])
  assert.equal(push.ok, false)
  assert.match(push.out, /read-only|403|forbidden/i)
})

test('the executor may publish work/* branches but not main', async () => {
  const s = await stack('code-branches')
  await commit(s.workspace, 'b.txt', 'b\n', 'b')

  const ok = await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/feature'])
  assert.equal(ok.ok, true, ok.out)

  const main = await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/main'])
  assert.equal(main.ok, false)
  assert.match(main.out, /work\/\*|refused|declined|rejected/)
})

test('history only moves forward: non-fast-forward pushes and deletes are refused', async () => {
  const s = await stack('code-ff')
  const first = await commit(s.workspace, 'c.txt', '1\n', 'one')
  assert.equal((await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/hist'])).ok, true)

  await commit(s.workspace, 'c.txt', '2\n', 'two')
  assert.equal((await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/hist'])).ok, true)

  // Rewrite history: reset to the first commit and try to force a different tip.
  await run('git', ['-C', s.workspace, 'reset', '-q', '--hard', first])
  await commit(s.workspace, 'c.txt', '3\n', 'three')
  const forced = await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, 'HEAD:refs/heads/work/hist'])
  assert.equal(forced.ok, false)
  assert.match(forced.out, /non-fast-forward|rejected|denied/i)

  const deleted = await gitAs(s.tokens.local, s.workspace, ['push', '-q', s.repoUrl, ':refs/heads/work/hist'])
  assert.equal(deleted.ok, false)
})

test('an unknown repository is not found', async () => {
  const s = await stack('code-404')
  const url = `${s.repoUrl.replace('project.git', 'nothere.git')}`
  const res = await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${s.tokens.global}` } })
  assert.equal(res.status, 404)
})

test('dumb-protocol and other endpoints are not offered', async () => {
  const s = await stack('code-dumb')
  const res = await fetch(`${s.repoUrl}/HEAD`, { headers: { authorization: `Bearer ${s.tokens.global}` } })
  assert.equal(res.status, 404)
})
