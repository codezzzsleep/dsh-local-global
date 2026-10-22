/**
 * Run git with a fixed argv (never a shell). Tokens are passed as an HTTP
 * header for one invocation only, so they are never written into .git/config,
 * and they are redacted from error messages.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function git(args, { cwd, token } = {}) {
  const prefix = token ? ['-c', `http.extraHeader=Authorization: Bearer ${token}`] : []
  try {
    const { stdout, stderr } = await execFileAsync('git', [...prefix, ...args], {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { stdout, stderr }
  } catch (error) {
    let message = String(error.stderr || error.message || '').trim()
    if (token) message = message.split(token).join('***')
    throw new Error(`git ${args[0]} failed: ${message}`)
  }
}

export async function gitOk(args, options) {
  try {
    await git(args, options)
    return true
  } catch {
    return false
  }
}
