/**
 * Layout for a three-sandbox deployment on one machine. Each role gets a
 * config file with only its own token, so a process started from the Global
 * config cannot present the executor's credentials.
 */
import { randomBytes } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRepo } from './code-sandbox.js'
import { git } from './git.js'
import { readJson, writeJsonAtomic } from './fsutil.js'

export const ROLES = Object.freeze(['local', 'global', 'human'])

export function tokenMap(tokens) {
  return new Map(Object.entries(tokens).map(([role, token]) => [token, role]))
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Create the three sandboxes' data, one repository, a workspace, and per-role configs. */
export async function initRoot({ root, commPort = 7701, codePort = 7702, repo = 'project' }) {
  const base = resolve(root)
  const tokens = Object.fromEntries(ROLES.map((role) => [role, randomBytes(24).toString('hex')]))
  const commUrl = `http://127.0.0.1:${commPort}`
  const codeRepoUrl = `http://127.0.0.1:${codePort}/git/${repo}.git`

  await writeJsonAtomic(join(base, 'server.json'), {
    comm: { port: commPort, dir: join(base, 'comm'), tokens },
    code: { port: codePort, root: join(base, 'code'), tokens, repo },
  })

  await createRepo(join(base, 'code'), repo)

  const workspace = join(base, 'workspace')
  if (!(await exists(join(workspace, '.git')))) {
    await mkdir(workspace, { recursive: true })
    await git(['init', '-q', workspace])
    await writeFile(join(workspace, 'README.md'), `# ${repo}\n`)
    await git(['add', '.'], { cwd: workspace })
    await git(
      ['-c', 'user.name=executor', '-c', 'user.email=executor@sandbox.local', 'commit', '-q', '-m', 'initial commit'],
      { cwd: workspace },
    )
  }

  await writeJsonAtomic(join(base, 'roles', 'local.json'), {
    comm: { url: commUrl, token: tokens.local },
    code: { url: codeRepoUrl, token: tokens.local, branch: 'work/main' },
    workspace,
    stateDir: join(base, 'state', 'local'),
  })
  await writeJsonAtomic(join(base, 'roles', 'global.json'), {
    comm: { url: commUrl, token: tokens.global },
    code: { url: codeRepoUrl, token: tokens.global },
    home: join(base, 'state', 'global'),
    model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  })
  await writeJsonAtomic(join(base, 'roles', 'human.json'), {
    comm: { url: commUrl, token: tokens.human },
    code: { url: codeRepoUrl, token: tokens.human },
  })

  return { root: base, commUrl, codeRepoUrl }
}

export async function loadRole(file) {
  return readJson(file, null)
}

export async function loadServer(root) {
  const config = await readJson(join(resolve(root), 'server.json'), null)
  if (!config) throw new Error(`no server.json in ${root}; run "lg init --root ${root}" first`)
  return config
}
