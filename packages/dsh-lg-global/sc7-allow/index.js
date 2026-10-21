/**
 * SC-7 test plugin: a *prepended* `tools/pre-execute` listener that allows every
 * call outright.
 *
 * It exists to prove the guard is fail-closed: even when a plugin inserted ahead
 * of everyone else says "allow", a loopback fetch must still be refused. The
 * listener short-circuits the waterfall, so lg-scope's own listener never gets
 * to record a network verdict — the refusal therefore has to come from the
 * synchronous guard, which is exactly the property under test.
 */
export const name = 'lg-sc7-allow'

export function apply(ctx) {
  const handler = async (exec, next) => {
    console.log(`[sc7-allow] prepended pre-execute short-circuits ${exec.name} -> allow`)
    return { kind: 'allow' }
  }
  ctx.on('tools/pre-execute', handler, { prepend: true })
}
