/**
 * `lg-commands` — the human side of the channel: bind, inspect, halt.
 */
import type { Context } from '@deepseek-ai/cordis'
// Module augmentation only: `ctx.commands` lives in dsh-commands.
import type {} from '@deepseek-ai/dsh-commands'
import { activeChannel } from './channel.js'

/** Cordis plugin name. */
export const name = 'lg-commands'

/** Services this plugin reads. */
export const inject = ['commands']

/**
 * Compose the channel commands.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'lg-bind',
    description: 'Bind this session as the only delivery target for the Local–Global channel.',
    handler: async ({ agent }) => {
      const channel = activeChannel()
      if (channel === undefined) {
        return { kind: 'error' as const, text: 'lg-channel is not composed in this profile' }
      }
      const sessionId = String(agent.session.id)
      await channel.bind(sessionId)
      return { kind: 'success' as const, text: `bound session ${sessionId} as ${channel.config.role}` }
    },
  })

  ctx.commands.register({
    name: 'lg-status',
    description: 'Show the bound session, delivery cursor, channel maximum, and open questions.',
    handler: async () => {
      const channel = activeChannel()
      if (channel === undefined) {
        return { kind: 'error' as const, text: 'lg-channel is not composed in this profile' }
      }
      return { kind: 'success' as const, text: await channel.statusText() }
    },
  })

  ctx.commands.register({
    name: 'lg-halt',
    description: 'Write a HALT to the channel as the human, stopping both sides.',
    input: { hint: '<reason>' },
    handler: async ({ rawInput }) => {
      const channel = activeChannel()
      if (channel === undefined) {
        return { kind: 'error' as const, text: 'lg-channel is not composed in this profile' }
      }
      const reason = rawInput.trim()
      if (reason.length === 0) {
        return { kind: 'error' as const, text: 'usage: /lg-halt <reason>' }
      }
      const result = await channel.postAs('human', { type: 'HALT', fields: { reason } })
      return { kind: 'success' as const, text: `halted: ${result.filename} (${result.commit.slice(0, 12)})` }
    },
  })
}
