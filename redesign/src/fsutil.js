import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Read and parse a JSON file; return `fallback` when it does not exist yet. */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

/** Write JSON so that readers see either the old file or the new one, never a partial write. */
export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' })
  await rename(tmp, file)
}

export async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
