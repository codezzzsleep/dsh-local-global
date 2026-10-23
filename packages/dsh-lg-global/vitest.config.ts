import { mergeConfig } from 'vitest/config'

import { bundleConfig } from '../../vitest.shared.js'

// The M4 suites drive real git repositories and a real channel; give a busy
// machine room before a test is called slow.
export default mergeConfig(bundleConfig(), { test: { testTimeout: 60_000 } })
