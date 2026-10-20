# M1 端到端验证（AC-4，E1–E8）

环境：本机真实 dsh `0.2.1-rc.2`，profile `lg-m1`，测试频道 `/tmp/lg-m1-channel.git`（bare）。
lg-channel 配置：`repo: file:///tmp/lg-m1-channel.git`、`role: local`、`pollSeconds: 10`、`relay: true`。

## 必须先说明的一点：会话由脚本创建，不是网页

0005 写的是“在打开的 Web 界面里新建会话并执行 `/lg-bind`”。这台机器没有可自动化的浏览器，
Web 界面需要人工点击，所以我的 E2E 驱动**在 dsh 进程内用公开的适配器 API 创建会话**：

| 动作 | 网页适配器做的事 | 我做的事 |
|---|---|---|
| 新建会话 | 调 `ctx.agents.create()` | 同一个调用 |
| 执行 `/lg-bind` | 命令面板 → `ctx.commands.execute()` | 同一个调用 |
| 触发工具调用 | 模型 function call → `ctx.tools.execute()` | 同一个调用 |

也就是说被验证的是 dsh 进程、profile、插件、命令与工具管线的真实行为，只有“谁点了按钮”不同。
如果 Global 要求必须是网页里人工点的记录，我可以另约一轮用 Playwright 跑真实 UI。

原始记录：`evidence/M1/e2e-evidence.jsonl`（每步一行 JSON，含时间戳、工具结果、会话事件尾部）。

## 结果总表

| 编号 | 操作 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| E1 | 脚本向测试频道提交合法 `0002-global-DIRECTIVE.md` | 30 秒内绑定会话收到 `[LG #0002 DIRECTIVE v1 from global]` | 推送于 `17:30:17.974Z`，会话于 `17:30:28.501Z` 收到该标签；间隔 10.5 秒（= 一个 `pollSeconds`） | PASS |
| E2 | 会话用 `lg_post` 发 REPORT | 频道出现 `0003-local-REPORT.md`，提交信息 `msg 0003 local REPORT` | commit `0c7673a`，标题 `msg 0003 local REPORT`，文件内容含 `refs`/`commit`/`directive_version`/`evidence`/`negative_tests` | PASS |
| E3 | 会话用 `lg_post` 发 DIRECTIVE | 工具拒绝，说明角色越权 | `isError: true`，`local may not send DIRECTIVE; allowed senders are global`；频道无新增 | PASS |
| E4 | 脚本提交缺 `version` 的 `0004-global-DIRECTIVE.md` | 会话收到 `[LG INVALID #0004]`，而不是原文 | 收到 `[LG INVALID #0004] DIRECTIVE requires field "version"; … "priorities"; … "acceptance"; … "scope"`；原文 `no version field` 未出现 | PASS |
| E5 | 重启 dsh | 0002、0004 不被重复投递 | 新进程绑定新会话后等待 12 秒（>1 个轮询周期），会话事件为空，`redelivered: false`，游标仍为 `0004` | PASS |
| E6 | 会话运行时脚本提交 `human` HALT | 当前回合被中止，之后不再投递 | 先观测到 `status=running` 再推 HALT；随后 `status=idle`，会话事件尾部出现 `turn/end`，HALT 文本已投递 | PASS |
| E7 | 界面执行 `/lg-halt 测试` | 频道出现 `human` 的 HALT，含原因 | `0006-human-HALT.md`，commit `3148173`，`reason: e2e halt via command` | PASS |
| E8 | 把一段 Global 消息全文交给 `lg_record_relayed` | 存档文件与输入逐字节一致 | 输入 sha256 `c393ea90…7866`，存档 `0007-global-DIRECTIVE.md` sha256 同为 `c393ea90…7866`，`identical: true` | PASS |

## 顺序与失败处理

E1→E8 严格按序执行。任何一步的等待都设了超时（E1 30 秒、E4 40 秒、E6 40 秒），超时即记为失败并停止后续，
不会带着失败继续跑后面的项。本次无超时。

## 测试频道的最终形态

```text
a67ccbd msg 0007 global DIRECTIVE   ← E8 relayed
3148173 msg 0006 human HALT         ← E7 /lg-halt
f6a7ac7 msg 0005 human HALT         ← E6
0383920 msg 0004 global DIRECTIVE   ← E4（故意非法）
0c7673a msg 0003 local REPORT       ← E2
8fe1530 msg 0002 global DIRECTIVE   ← E1
f1a92ce msg 0001 human TASK         ← 种子，保证序号从 0001 连续
```

每个提交只含一条消息，提交信息符合 `msg <序号> <发送者> <类型>`。
完整提交日志与 0002/0007 两个文件的原文见 `evidence/M1/e2e-channel-log.txt`。
