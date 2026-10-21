[LG ISOLATION_REPORT from global]
probes:
  - name: session-cwd
    expected: pass
    actual: /var/lib/deepseek-harness/.dsh-global-m2/workspace is inside /var/lib/deepseek-harness/.dsh-global-m2/workspace
    pass: true
  - name: tool-whitelist
    expected: pass
    actual: 19 tools, all allowed
    pass: true
  - name: profile-name
    expected: pass
    actual: lg-global-m2
    pass: true
  - name: preset-registry
    expected: pass
    actual: lg-global only
    pass: true
  - name: preset-composition
    expected: pass
    actual: 1 activated, 1 named lg-global
    pass: true
  - name: sent-copies
    expected: pass
    actual: archive matches every saved copy
    pass: true
  - name: role-file
    expected: pass
    actual: /var/lib/deepseek-harness/.dsh-global-m2/workspace/LG-ROLE.md (55 bytes)
    pass: true
---
启动自检：7/7 项通过。

篡改一行
