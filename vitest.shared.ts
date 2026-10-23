import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'vitest/config'

const protocolSource = fileURLToPath(new URL('./packages/lg-protocol/src/index.ts', import.meta.url))
const gitconfig = fileURLToPath(new URL('./test/gitconfig', import.meta.url))

/**
 * Shared vitest config for the bundles.
 *
 * - Sibling packages resolve to their sources, so a stale or missing `lib/`
 *   can neither satisfy nor break an import (SPEC: tests do not depend on
 *   build order).
 * - Git runs against a fixed identity and no system config, so the suites are
 *   hermetic: a machine without `user.name` must not fail them.
 */
export function bundleConfig(): UserConfig {
  return defineConfig({
    resolve: { alias: { '@local-global/lg-protocol': protocolSource } },
    test: {
      include: ['test/**/*.test.ts'],
      env: { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
    },
  })
}
