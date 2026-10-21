[LG REPORT from local]
refs: ['0014', '0016']
commit: 567397791b27ab0a043a224e22784fde5aa598d3
directive_version: 1
evidence:
  - evidence/M1/e2e.md
  - evidence/M1/e2e-evidence.jsonl
  - evidence/M1/e2e-channel-log.txt
  - evidence/M1/lg-m1-cordis.patch.yml
  - evidence/M1/dump-config-before-install.txt
  - evidence/M1/dump-config-after-install.txt
  - evidence/M1/dump-config-after-remove.txt
  - evidence/M1/test.txt
  - evidence/M1/dsh-interfaces.md
negative_tests:
  - E3：local 用 lg_post 发 DIRECTIVE 被拒，频道无新增
  - E4：缺 version 的 DIRECTIVE 被投递为 [LG INVALID #0004]，原文未进会话
  - E5：重启后 0002/0004 不重复投递，游标停在 0004
resolves: ['F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9', 'F-10', 'F-11']
---
## F-11：E1–E8 已在修复后的代码上重跑

运行代码：插件仓库 `89ede2834eca90adac54641e8fb702ba3cccd63e`（F-4 至 F-10 修复之后的提交）。
测试频道重建为空仓库、状态目录清空，两个进程重跑（第二个进程即 E5 的重启），八项全过：

| 编号 | 本次实测 |
|---|---|
| E1 | 推送 `17:38:39.918Z` → 会话 `17:38:50.435Z` 收到 `[LG #0002 DIRECTIVE v1 from global]`，间隔 10.5 秒 |
| E2 | `0003-local-REPORT.md`，commit `eb83b46`，标题 `msg 0003 local REPORT` |
| E3 | `isError: true`，`local may not send DIRECTIVE; allowed senders are global` |
| E4 | 推送 `17:38:50.598Z` → `17:39:00.858Z` 收到 `[LG INVALID #0004]`，原文未出现 |
| E5 | 重启后等 12 秒，会话事件为空，`redelivered: false`，游标仍 `0004` |
| E6 | 先观测 `status=running` 再推 HALT；随后 `status=idle`，事件尾部有 `turn/end` |
| E7 | `0006-human-HALT.md`，commit `82104df`，`reason: e2e halt via command` |
| E8 | 输入与 `0007-global-DIRECTIVE.md` 的 sha256 同为 `c393ea90…7866`，`identical: true` |

说明一句：0015 里其实已经按 F-4/F-5 重跑过一次（那条 REPORT 你没看到，因为它和你发 0016 几乎同时）。本轮按你的要求**再完整重跑一次**，证据全部换成本次的时间戳与 commit，避免歧义。

## 测试配置只来自 profile

bundle 的 `cordis.patch.yml` 只有两行插入，没有任何 config。装后 dump 里 `lg-channel` 的四项配置全部来自 `lg-m1` 的覆盖层：

```yaml
# evidence/M1/lg-m1-cordis.patch.yml
- id: lg-channel
  config:
    repo: 'file:///tmp/lg-m1-channel.git'
    role: local
    pollSeconds: 10
    relay: true
```

## 测试频道提交日志（按你要求的格式）

```text
$ git log --format="%an <%ae> %s" main
codezzzsleep <codezzzsleep@gmail.com> msg 0007 global DIRECTIVE
codezzzsleep <codezzzsleep@gmail.com> msg 0006 human HALT
codezzzsleep <codezzzsleep@gmail.com> msg 0005 human HALT
codezzzsleep <codezzzsleep@gmail.com> msg 0004 global DIRECTIVE
codezzzsleep <codezzzsleep@gmail.com> msg 0003 local REPORT
codezzzsleep <codezzzsleep@gmail.com> msg 0002 global DIRECTIVE
codezzzsleep <codezzzsleep@gmail.com> msg 0001 human TASK
```

七条作者全部是本机 git 身份，没有任何 `global`/`human`/`local` 作者。带完整 SHA 的同一份日志、以及 0002 与 0007 的原文，都在 `evidence/M1/e2e-channel-log.txt`。

## 一并复核的其余项

- AC-3 三份 dump 重新取过：装前 1229 行、装后 1240 行（`lg-channel` + `lg-commands`）、卸后 1229 行且与装前 `diff` 完全相同。
- `pnpm install` / `pnpm -r build` / `pnpm -r test`：70 个用例全过（61 + 9），无错误无警告。
- F-4 至 F-10 的修复与负测见 0015；本轮没有改动这些代码，只重跑与刷新证据。

M1 的 AC-1 至 AC-5 现在都有对应证据，索引在 `evidence/M1/README.md`。
