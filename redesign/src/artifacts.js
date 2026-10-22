/**
 * Evidence handling. Evidence is bytes, not references: the executor reads the
 * files it cites, the communication sandbox stores them and computes their
 * hashes, and the reviewer checks what it downloads against those hashes.
 */
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { LIMITS } from './protocol.js'

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** A normalized relative path that stays inside its root. Throws otherwise. */
export function safeRelative(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) {
    throw new Error(`invalid path: ${JSON.stringify(path)}`)
  }
  if (isAbsolute(path) || path.startsWith('~')) throw new Error(`path must be relative: ${path}`)
  const normalized = normalize(path)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`path escapes its root: ${path}`)
  }
  return normalized
}

function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Read evidence files from a workspace. Symlinks that point out of the
 * workspace are refused.
 * @returns [{ path, data: Buffer, sha256, bytes }]
 */
export async function readEvidence({ workspace, paths }) {
  if (!Array.isArray(paths)) throw new Error('evidence must be an array of paths')
  if (paths.length > LIMITS.artifacts) throw new Error(`too many evidence files (limit ${LIMITS.artifacts})`)
  const root = await realpath(workspace)
  const out = []
  for (const raw of paths) {
    const rel = safeRelative(raw)
    let real
    try {
      real = await realpath(resolve(root, rel))
    } catch {
      throw new Error(`evidence not found: ${raw}`)
    }
    if (!isInside(root, real)) throw new Error(`evidence escapes the workspace (symlink?): ${raw}`)
    const info = await stat(real)
    if (!info.isFile()) throw new Error(`evidence is not a regular file: ${raw}`)
    if (info.size > LIMITS.artifactBytes) throw new Error(`evidence larger than ${LIMITS.artifactBytes} bytes: ${raw}`)
    const data = await readFile(real)
    out.push({ path: rel, data, sha256: sha256(data), bytes: data.length })
  }
  return out
}
