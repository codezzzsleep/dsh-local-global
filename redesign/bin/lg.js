#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { CommClient } from '../src/comm-client.js'
import { createCommSandbox } from '../src/comm-sandbox.js'
import { createCodeSandbox } from '../src/code-sandbox.js'
import { createGlobal } from '../src/global.js'
import { OpenAICompatibleModel } from '../src/model.js'
import { say, log } from '../src/human.js'
import { initRoot, loadRole, loadServer, tokenMap } from '../src/config.js'

const USAGE = `usage:
  lg init   --root DIR [--comm-port 7701] [--code-port 7702]
  lg serve  --root DIR                     run the communication and code sandboxes
  lg global tick --config FILE             process new messages as the reviewer
  lg human say   --config FILE --to local|global [--kind task|note] TEXT...
  lg human log   --config FILE [--kind KIND] [--to ROLE]

environment (global tick):
  LG_API_KEY    required
  LG_BASE_URL   optional, overrides the model endpoint in the config
  LG_MODEL      optional, overrides the model name in the config`

function die(message) {
  console.error(message)
  process.exit(1)
}

async function serve(root) {
  const config = await loadServer(root)
  const comm = createCommSandbox({ dir: config.comm.dir, tokens: tokenMap(config.comm.tokens) })
  const code = createCodeSandbox({ root: config.code.root, tokens: tokenMap(config.code.tokens) })
  const commUrl = await comm.listen(config.comm.port)
  const codeUrl = await code.listen(config.code.port)
  console.log(`communication sandbox  ${commUrl}`)
  console.log(`code sandbox           ${codeUrl}/git/${config.code.repo}.git`)
  const stop = async () => {
    await Promise.all([comm.close(), code.close()])
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: 'string' },
      'comm-port': { type: 'string' },
      'code-port': { type: 'string' },
      config: { type: 'string' },
      to: { type: 'string' },
      kind: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [area, action, ...rest] = positionals
  if (values.help || !area) {
    console.log(USAGE)
    return
  }

  if (area === 'init') {
    if (!values.root) die('--root is required')
    const result = await initRoot({
      root: values.root,
      commPort: values['comm-port'] ? Number(values['comm-port']) : undefined,
      codePort: values['code-port'] ? Number(values['code-port']) : undefined,
    })
    console.log(`initialized ${result.root}`)
    console.log(`start the sandboxes:  lg serve --root ${result.root}`)
    return
  }

  if (area === 'serve') {
    if (!values.root) die('--root is required')
    await serve(values.root)
    return
  }

  if (!values.config) die('--config is required')
  const role = await loadRole(values.config)
  if (!role) die(`cannot read ${values.config}`)

  if (area === 'global' && action === 'tick') {
    if (!process.env.LG_API_KEY) die('LG_API_KEY is required')
    const model = new OpenAICompatibleModel({
      baseUrl: process.env.LG_BASE_URL ?? role.model.baseUrl,
      apiKey: process.env.LG_API_KEY,
      model: process.env.LG_MODEL ?? role.model.model,
    })
    const global = createGlobal({
      home: role.home,
      comm: new CommClient({ url: role.comm.url, token: role.comm.token }),
      code: role.code,
      model,
    })
    console.log(JSON.stringify(await global.tick(), null, 2))
    return
  }

  const comm = new CommClient({ url: role.comm.url, token: role.comm.token })

  if (area === 'human' && action === 'say') {
    if (values.to !== 'local' && values.to !== 'global') die('--to must be local or global')
    const text = rest.join(' ')
    if (!text) die('message text is required')
    console.log(await say(comm, { to: values.to, text, kind: values.kind ?? 'task' }))
    return
  }

  if (area === 'human' && action === 'log') {
    for (const line of await log(comm, { kind: values.kind, to: values.to })) console.log(line)
    return
  }

  console.error(USAGE)
  process.exit(2)
}

main().catch((error) => die(error.message))
