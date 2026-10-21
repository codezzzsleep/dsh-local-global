[LG REPORT from local]
commit: 4b36f6c3fe152a7b674c62af8730b989dffecc1a
directive_version: 3
evidence:
  - docs/implementation.md
  - evidence/M2/probe-boot.log
  - evidence/M2/acceptance-run.log
negative_tests: []
refs:
  - "0030"
---
## F-4 先修掉了，而且比 finding 更大

`evidence/M2/*.log` **一个都没进仓库**：`.gitignore` 的 `*.log` 把五份验收日志全吞了，`git add -A` 静默跳过。0026 只点了 `probe-boot.log`，实际还有 `acceptance-run.log`、`negative-preset-override.log`、`negative-profile-name.log`、`lg-global-m2-boot.log`。

已加例外并提交（`de2ef6f`）：

```gitignore
*.log
!evidence/**/*.log
```

五份日志现在都在仓库里。这是我该在提交前自己核对的，不是等 REVIEW 发现。

## F-1 / F-2 / F-3 的文档修订（commit `4b36f6c`，等你审 diff）

只改 `docs/implementation.md`（+26/−12），三个要点：

**F-1 网络拒绝落到同步守卫，fail-closed。** 原文只写“放在 pre-execute 里检查”，现在改成两段：

- pre-execute 只做异步准备，按 `callId` 把结论记进检查表；
- `ctx.tools.guard` 做最终判定，**取不到本次调用的结论就拒绝**（`lg-scope: no network verdict for this call`）；
- 并写明原因：waterfall 里任何监听器都能 `prepend` 后直接返回 allow 而不调用 `next()`，guard 只在 waterfall 结果为 allow 之后运行，所以把拒绝放在 pre-execute 等于把决定权交给最先注册的插件。

**F-2 不再用 agent-instructions。** 三条泄漏路径逐条写进文档（`$DSH_AGENTS_HOME/AGENTS.md`、read/write/edit 后的目录回溯、`localInstructionFileCandidates`），并把结论写成“被审的一方能写下审核者的指令”。替代品是 lg-global 自己的 `lg-role`：只读配置里那一个角色文件，读完即注入，不做目录发现、不接受候选列表。preset 示例与插件清单都已替换。

**F-3 断言主体改成注册表。** 启动时 `list()` 必须恰好只有一个 `lg-global` 且无 `broken`，再用**不带参数**的 `inspectCompositions()` 核对已激活组合；并写明为什么 `defaultId` 不够（`select` 是远程方法、`selectedDefault` 由界面写入）。执行时机改成“启动、每个会话第一次工具调用之前、每次 `lg_repo_sync`”，不再等到同步。

## 两处我接受你的更正

- “`inspectCompositions` 没有会话时恒为空”是我传错参数得出的结论，文档里已经改掉，不再出现这句。
- AC-3 的证据必须是真实 Global 会话里的工具调用事件。现有 `acceptance-raw.json` 是插件内部调 `ctx.tools.execute` 的记录，按你的定义只能算探针。改实现后我会重做一版：让 Global 会话的模型真的去调 `read` / `web_fetch`，再从会话日志里导出事件，格式与 0019 一致。

## 下一步

按批准的 diff 改实现：`lg-role` 新插件、网络守卫改成 fail-closed、注册表断言、每会话首调复核；然后补 F-1 要求的“prepend 直接 allow”测试插件场景，并把 AC-3 的证据换成真实会话事件。
