import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Tests run against the protocol sources, not the built `lib/`. Without this
 * alias a stale build silently satisfies the imports: the first REVIEW test run
 * passed against a lib that predated REVIEW support.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@local-global/lg-protocol': fileURLToPath(new URL('../lg-protocol/src/index.ts', import.meta.url)),
    },
  },
})
