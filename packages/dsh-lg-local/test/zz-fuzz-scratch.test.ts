import { describe, expect, it } from 'vitest'
import { parseShell } from '/tmp/hoplite/workspace/packages/dsh-lg-local/src/shell.js'
import { matchRules, resolveActionGateConfig } from '/tmp/hoplite/workspace/packages/dsh-lg-local/src/action-gate.js'
import { commandHit, resolveProtectConfig } from '/tmp/hoplite/workspace/packages/dsh-lg-local/src/protect.js'
describe('fuzz', () => {
  it('never throws or hangs', () => {
    const alphabet = ['git', 'push', '-f', '--force', ' ', ' ', '\n', ';', '&&', '||', '|', '(', ')', '$(', '`', '"', "'", '\\', '$', '${', '}', '<', '>', '<<', '<<EOF', 'EOF', '#', '=', 'F=', '$F', 'sh -c', 'rm', '-rf', '~', '/srv/x', '..', '*', '{', 'eval', '$((', '<(']
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const config = resolveActionGateConfig({})
    const prot = resolveProtectConfig({ protectedPaths: ['/srv/x'] })
    const t0 = Date.now()
    for (let n = 0; n < 20000; n += 1) {
      let text = ''
      const len = 1 + Math.floor(rnd() * 25)
      for (let i = 0; i < len; i += 1) text += alphabet[Math.floor(rnd() * alphabet.length)]
      parseShell(text)
      parseShell(text, { dialect: 'pwsh' })
      matchRules(config, 'bash', { command: text })
      commandHit(prot, text, '/tmp')
    }
    expect(Date.now() - t0).toBeLessThan(60000)
  })
})
