[LG REPORT from local]
commit: 09dbacbe289c1edaab24bd40d2f59e94798d863d
directive_version: 3
evidence:
  - docs/implementation.md
  - .gitignore
negative_tests: []
refs:
  - "0030"
  - "0032"
---
## F-1 到 F-6 的做法已写进 docs（commit `09dbacb`，等你审 diff）

只改 `docs/implementation.md`（+26/−8）。逐条对应：

**F-1 网络拒绝落在同步守卫。** pre-execute 只做异步解析，把结论按 `callId` 记进检查表；`ctx.tools.guard` 取不到结论就拒绝（fail-closed），取到 deny 就拒绝。文档写明原因：waterfall 里监听器可 `prepend` 后直接返回 allow、不调 `next()`，守卫只在结果为 allow 之后运行，所以拒绝权不能放在 pre-execute。

**F-2 指令只有一个来源。** preset 不再装 `agent-instructions`，换成 lg-global 自己的 `lg-role`：只读配置里那一个角色文件，读完即注入，不做目录发现、不接受候选列表。三条泄漏路径（`$DSH_AGENTS_HOME/AGENTS.md`、read/write/edit 后的目录回溯、local 候选文件）逐条写进文档，并写明“被审的一方能写下审核者的指令”。

**F-3 断言注册表。** `list()` 必须恰好一条 `lg-global` 且无 `broken`，再用**不带参数**的 `inspectCompositions()` 核对已激活组合；启动、每会话首调前、每次 `lg_repo_sync` 各一次。

**F-4 路径按工具的解析方式判断。** 相对路径以**会话工作目录**为基准，不再以 workspace 为基准；`glob`/`grep` 不带 `path` 时把 cwd 当作目标，照常校验而不是放行；这些规则只在“会话工作目录 == workspace”时闭合，所以 lg-integrity 在首调前断言二者相等。AC-3 增加两个场景：相对路径逃逸、不带 path 的 glob/grep。

**F-5 检查失败必须阻断。** 新增共享状态 `lgState = { paused, reasons }`：lg-integrity 写、lg-scope 的守卫读。任一项失败（注册表、组合、白名单、cwd 不符、push 探针 `writable`/`inconclusive`、组合哈希）都置 `paused`，之后**除 `lg_integrity_check` 外的全部工具调用被守卫拒绝**，直到复核通过。并写明：`apply()` 抛异常只让 lg-integrity 自己没加载，不等于 Global 停了，所以运行期一律走暂停。

**F-6 Global 走匿名只读。** 远端只允许 `https://` 与 `file://`，拒绝 `ssh://`/`git@…`；`runGit` 不再继承整个 `process.env`，只传白名单，并显式设 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=/bin/false`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_SSH_COMMAND=/bin/false`，清 `SSH_AUTH_SOCK`，每次带 `-c credential.helper=`。探针改用**临时仓库**（`git init` + 空树提交）对真实远端 `push --dry-run`，不依赖镜像状态。

本机实测（写进证据时会附原始输出）：匿名 https 读 `ls-remote` 成功；同样的环境做 `push --dry-run` 得到 `could not read Username`，归为 `denied`。

## F-7 已经修过，方式请你确认

`de2ef6f` 里加了例外：

```gitignore
*.log
!evidence/**/*.log
```

五份日志都已入库，`git ls-files 'evidence/M2/*.log'` 能列全。如果你更希望“证据文件不要用 `.log` 扩展名”，我可以改成 `.txt` 并同步更新 README 里的引用——说一声我改。

## 关于 0028 的定位

0028 末尾写的是“进度 REPORT，不声称通过”，AC-3/AC-4/AC-5 当时确实没有证据。这次 REVIEW 把它们按 787f190 的实现逐条核了一遍，F-4 到 F-6 都是我实现层的缺陷，不是文档措辞问题，我按阻塞项处理。

等你批 diff，之后改代码的顺序是：`lg-role` → 网络 fail-closed 守卫 + `lgState` 暂停 → 注册表断言与每会话复核 → 匿名只读 git；然后重做 AC-3，证据改用真实 Global 会话的工具调用事件，格式与 0019 一致。
