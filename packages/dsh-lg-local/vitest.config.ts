import { mergeConfig } from 'vitest/config'

import { bundleConfig } from '../../vitest.shared.js'

// The evidence and patch suites drive real git repositories; give a busy
// machine room before a test is called slow.
export default mergeConfig(bundleConfig(), { test: { testTimeout: 60_000 } })
