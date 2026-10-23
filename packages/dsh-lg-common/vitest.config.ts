import { mergeConfig } from 'vitest/config'
import { bundleConfig } from '../../vitest.shared.js'

// These suites drive real git repositories; a loaded machine needs more than vitest's 5 s per test.
export default mergeConfig(bundleConfig(), { test: { testTimeout: 60_000 } })
