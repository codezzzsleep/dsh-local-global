import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createCommSandbox } from '../src/comm-sandbox.js'
import { createCodeSandbox, createRepo } from '../src/code-sandbox.js'
import { CommClient } from '../src/comm-client.js'
import { tokenMap } from '../src/config.js'
import { randomBytes } from 'node:crypto'

const run = promisify(execFile)

/** A fresh temporary root for one test. */
export async function scratch(label) {
  return mkdtemp(join(tmpdir(), `lg-${label}-`))
}

/**
 * Start the communication and code sandboxes on random local ports, with one
 * token per role, and a clean executor workspace with one commit.
 */
export async function startStack(label) {
  const root = await scratch(label)
  const tokens = { local: randomBytes(16).toString('hex'), global: randomBytes(16).toString('hex'), human: randomBytes(16).toString('hex') }

  const comm = createCommSandbox({ dir: join(root, 'comm'), tokens: tokenMap(tokens) })
  const commUrl = await comm.listen(0)

  const codeRoot = join(root, 'code')
  await createRepo(codeRoot, 'project')
  const code = createCodeSandbox({ root: codeRoot, tokens: tokenMap(tokens) })
  const codeUrl = await code.listen(0)
  const repoUrl = `${codeUrl}/git/project.git`

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await run('git', ['init', '-q', workspace])
  await writeFile(join(workspace, 'README.md'), 'hello\n')
  await run('git', ['-C', workspace, 'add', '.'])
  await run('git', ['-C', workspace, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'])

  return {
    root,
    tokens,
    commUrl,
    repoUrl,
    workspace,
    comm,
    code,
    client: (role) => new CommClient({ url: commUrl, token: tokens[role] }),
    localConfig: () => ({
      comm: new CommClient({ url: commUrl, token: tokens.local }),
      code: { url: repoUrl, token: tokens.local, branch: 'work/main' },
      workspace,
      stateDir: join(root, 'state', 'local'),
    }),
    globalConfig: () => ({
      comm: new CommClient({ url: commUrl, token: tokens.global }),
      code: { url: repoUrl, token: tokens.global },
      home: join(root, 'state', 'global'),
    }),
    async close() {
      await Promise.all([comm.close(), code.close()])
    },
  }
}

export async function commit(workspace, file, content, message = 'change') {
  await writeFile(join(workspace, file), content)
  await run('git', ['-C', workspace, 'add', '.'])
  await run('git', ['-C', workspace, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', message])
  const { stdout } = await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])
  return stdout.trim()
}
