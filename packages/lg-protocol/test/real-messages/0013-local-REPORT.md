[LG REPORT from local]
refs: ['0005', '0011']
commit: 3b6c0fd03a3cc70ade9d8646de15b8ac1d1364ae
directive_version: 1
evidence:
  - evidence/M1/README.md
  - evidence/M1/test.txt
  - evidence/M1/e2e.md
  - evidence/M1/e2e-evidence.jsonl
  - evidence/M1/e2e-channel-log.txt
  - evidence/M1/dump-config-before-install.txt
  - evidence/M1/dump-config-after-install.txt
  - evidence/M1/dump-config-after-remove.txt
negative_tests:
  - E3：local 用 lg_post 发 DIRECTIVE 被拒（isError，且频道无新增）
  - E4：缺 version 的 DIRECTIVE 被投递为 [LG INVALID #0004]，原文未进会话
  - E5：重启后 0002/0004 不重复投递，游标停在 0004
---
## P3 完成：AC-3 安装与卸载

`dsh plugin --profile lg-m1 add ./packages/dsh-lg-common` 装得进，`remove` 卸得掉，三份 `--dump-config`：

| 阶段 | 行数 | 结果 |
|---|---|---|
| 装前 | 1229 | 无任何 `lg-` 行 |
| 装后 | 1239 | 末两条为 `lg-channel`（repo/role/pollSeconds/relay 四项配置齐全）与 `lg-commands` |
| 卸后 | 1229 | 与装前 `diff` 完全相同 |

## P4 完成：AC-4 E1–E8

八项全过，无超时。要点：

| 编号 | 实测 |
|---|---|
| E1 | 推送 `17:30:17.974Z` → 会话 `17:30:28.501Z` 收到 `[LG #0002 DIRECTIVE v1 from global]`，间隔 10.5 秒（一个 pollSeconds） |
| E2 | `0003-local-REPORT.md`，commit `0c7673a`，标题 `msg 0003 local REPORT` |
| E3 | `isError: true`，`local may not send DIRECTIVE; allowed senders are global` |
| E4 | `[LG INVALID #0004]` + 四条缺字段说明；原文未出现 |
| E5 | 重启后等 12 秒，会话事件为空，`redelivered: false`，游标仍 `0004` |
| E6 | 先观测 `status=running` 再推 HALT；随后 `status=idle`，事件尾部有 `turn/end` |
| E7 | `0006-human-HALT.md`，`reason: e2e halt via command` |
| E8 | 输入与存档 sha256 同为 `c393ea90…7866`，`identical: true` |

## 必须记录的偏离：E2E 的会话是脚本创建的，不是网页点的

0005 要求在 Web 界面里新建会话并执行 `/lg-bind`。这台机器没有可自动化的浏览器（Web 界面需人工点击），
所以驱动脚本在 dsh 进程内直接调 `ctx.agents.create()`、`ctx.commands.execute()`、`ctx.tools.execute()`——
这三个正是 Web 适配器内部使用的公开接口。被验证的是真实的 dsh 进程、真实 profile、真实 git 仓库、
真实的命令与工具管线；差别只在“谁触发”。

这算不算满足 AC-4，请你判定。若不接受，我可以另跑一轮 Playwright 驱动真实 UI，那需要额外时间但不改代码。

## AC-5 与索引

`evidence/M1/README.md` 逐项列出 AC-1 至 AC-4 的证据文件、执行命令、环境（全部 real）和结果，含从零复现步骤。

## M1 状态

AC-1 至 AC-5 全部有证据，其中 AC-1 的作者条款按 Human 要求作废。lg-protocol、lg-channel、lg-commands 三个交付物都在仓库里：

```text
packages/lg-protocol        消息解析、校验、渲染、取号、折叠、动作指纹
packages/dsh-lg-common      lg-channel（git 后端、lg_post/lg_read/lg_open_questions/lg_record_relayed）
                            lg-commands（/lg-bind、/lg-status、/lg-halt）
```

65 个测试全过，装/卸/重启/并发都验过。等你对 AC-4 的偏离作出判断后再进 M2。
