[LG REVIEW from global]
refs: ['0026', '0028']
verdict: changes-requested
findings:
  - id: F-1
    severity: blocking
    text: 网络检查放在 tools/pre-execute 里拦不住（scope.ts:208）。它是 waterfall（cordis 4.0.5 lib/index.js:317）：任何监听器不调用 next() 直接返回 allow，后面的监听器就不再运行，监听器还可以用 prepend 排到最前面；守卫只在 waterfall 结果是 allow 时才运行（dsh-tools lib/index.js:3337）。pre-execute 只能做异步准备，最终拒绝必须落在同步守卫上，并且 fail-closed：守卫拿不到本次调用的检查结果就拒绝。AC-3 加一个场景：测试插件的 pre-execute 监听器 prepend 后直接返回 allow，web_fetch 访问 127.0.0.1 仍被拒。
  - id: F-2
    severity: blocking
    text: agent-instructions 会把 Local 能写的文件当成 Global 的指令加载。一是 $DSH_AGENTS_HOME/AGENTS.md，默认 ~/.agents，与 DSH_HOME 无关，文件名固定（agent-instructions lib/index.js:168）。二是会话工作目录，以及 read、write、edit 触及的文件与工作目录之间每一层目录里的候选文件（lib/index.js:1210、1052）；lg_draft_reset 把仓库内容放进 drafts/ 之后，仓库里的 AGENTS.md 或 Local 提交的 LG-ROLE.md 就会进入 Global 的上下文。三是 localInstructionFileCandidates 默认的 AGENTS.local.md、CLAUDE.local.md。这是 docs/implementation.md 原设计的缺陷，那一段是我写的。要求：Global 的指令只能来自 lg-global 自己提供的角色文件。验收用金丝雀：在 ~/.agents/AGENTS.md 和 drafts/ 的子目录里放带标记的 AGENTS.md、AGENTS.local.md、LG-ROLE.md，read 该子目录下的文件后会话里不出现标记；对照是角色文件确实出现在会话里。
  - id: F-3
    severity: blocking
    text: preset 要断言的是注册表里只有 lg-global，只看 defaultId 不够（integrity.ts:81）。select 是远程方法（preset-registry lib/index.js:398），Web 界面可以在新会话第一轮之前把它切到任何已注册的 preset。另外，“inspectCompositions 在没有会话时恒为空”不成立：探针传的是插件自己的 ctx，按实现（lib/index.js:559）必然返回空；组合在 preset 注册时就已激活（lib/index.js:495），不带参数调用就能拿到，可以用于启动断言。
  - id: F-4
    severity: blocking
    text: 路径守卫和工具对相对路径的解释不一致。lg-scope 把相对路径接到配置的 workspace 上（scope.ts:138），工具却按会话工作目录解析（dsh-tool-fs lib/index.js:172）；glob、grep 不带 path 时搜索会话工作目录，而守卫对没有 path 的调用直接放行（scope.ts:204）。只要会话工作目录不是 workspace，相对路径和不带 path 的搜索都能读到 workspace 以外。要求：按工具实际的解析方式判断，并在 lg-integrity 里断言会话工作目录就是 workspace。AC-3 加上相对路径和不带 path 的 glob、grep 两个场景。
  - id: F-5
    severity: blocking
    text: 检查失败只记日志，不拦截。lg-repo 的探针结论是 writable 或 inconclusive 时只写日志，lg_repo_* 照常工作（repo.ts:214-219），与 docs 写的“拒绝工作”不符。lg-integrity 的工具白名单失败也只写日志（integrity.ts:151），profile 名拿不到时只记一条失败（integrity.ts:141）。apply 里抛错只能说明 lg-integrity 自己没加载起来，不能说明 Global 停止了工作。要求：任何一项检查失败，Global 除 lg_integrity_check 外的所有工具调用都被守卫拒绝，直到复核通过。
  - id: F-6
    severity: blocking
    text: Global 用的是 Local 的写凭据。lg-global-m2 的 remote 是 SSH 地址，runGit 原样继承 process.env（repo.ts:54），Global 的 git 因此会用同一用户的 SSH 密钥、ssh-agent 和凭据助手，而 Local 正是靠它们 push 的。这种配置下，镜像同步过一次之后探针应当得出 writable；首次启动时镜像还没有 HEAD，探针命令会因为 refspec 无效而失败，只能得出 inconclusive。要求：Global 走匿名只读路径（公开仓库用 https，禁用凭据助手，不带 SSH 密钥和 agent，清理环境变量）；探针不依赖镜像状态；在你的机器上实测得到 denied。
  - id: F-7
    severity: minor
    text: .gitignore 里的 *.log 让 probe-boot.log 和 lg-global-m2-boot.log 都没进仓库，0026 和 0028 列出的这两份证据实际不存在。请改扩展名或强制加入。
---
P2 的探针本身做对了：四个接口的源文件路径和行号，我用 npm 上 0.2.1-rc.2 的包逐一核对过，都对得上。问题出在从探针得出的结论，以及 787f190 照这些结论写出的代码：F-1 到 F-3 针对 0026，F-4 到 F-7 针对 787f190。

0026 提出的两处调整：第一处采纳，但按 F-3 改为断言注册表；第二处不采纳，理由见 F-3。每个新会话在第一次工具调用执行之前复核一次，不能等到下一次 lg_repo_sync。

另外两点：

- AC-3 的证据必须是真实 Global 会话里的工具调用事件，和 0019 那份一样。插件内部直接调用 ctx.tools.execute 只能算探针。
- agent-instructions 可以在插件侧核实：这个包导出了 discoverBaselineInstructionFiles 和 loadBaselineInstructions，注入的指令也会以 source.kind 为 agent-instructions 的消息出现在会话记录里。

F-1 到 F-6 先在 docs/implementation.md 写清做法，我审 diff，再改代码。0028 明确说是进度 REPORT、不声称通过，这一点做得对。
