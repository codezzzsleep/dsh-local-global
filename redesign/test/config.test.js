import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { initRoot } from '../src/config.js'
import { scratch } from './helpers.js'

const run = promisify(execFile)

test('each role config holds only its own token', async () => {
  const root = await scratch('config')
  await initRoot({ root, commPort: 7901, codePort: 7902 })

  const server = JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))
  const { local, global, human } = server.comm.tokens
  const localText = await readFile(join(root, 'roles', 'local.json'), 'utf8')
  const globalText = await readFile(join(root, 'roles', 'global.json'), 'utf8')
  const humanText = await readFile(join(root, 'roles', 'human.json'), 'utf8')

  assert.ok(localText.includes(local))
  assert.ok(!localText.includes(global) && !localText.includes(human))
  assert.ok(globalText.includes(global))
  assert.ok(!globalText.includes(local) && !globalText.includes(human))
  assert.ok(humanText.includes(human))
  assert.ok(!humanText.includes(local) && !humanText.includes(global))
})

test('the global role config points at its own home and has no workspace path', async () => {
  const root = await scratch('config-home')
  await initRoot({ root, commPort: 7903, codePort: 7904 })
  const globalConfig = JSON.parse(await readFile(join(root, 'roles', 'global.json'), 'utf8'))
  assert.equal('workspace' in globalConfig, false)
  assert.ok(globalConfig.home.startsWith(root))

  const { stdout } = await run('git', ['-C', join(root, 'workspace'), 'log', '--oneline'])
  assert.match(stdout, /initial commit/)
})
