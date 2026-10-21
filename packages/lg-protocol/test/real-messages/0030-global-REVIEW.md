[LG REVIEW from global]
refs: ['0025', '0026']
verdict: changes-requested
findings:
  - id: F-1
    severity: blocking
    text: 网络检查放在 tools/pre-execute 里拦不住。它是 waterfall（cordis 4.0.5 lib/index.js:317）：任何监听器不调用 next() 直接返回 allow，后面的监听器就不再运行，而且监听器可以用 prepend 排到最前面；守卫只在 waterfall 的结果是 allow 时才运行（dsh-tools lib/index.js:3337）。所以 Global profile 里任何一个插件都能让 lg-scope 的网络检查被跳过。pre-execute 只能做异步的准备工作，最终的拒绝必须落在同步守卫上，并且 fail-closed：守卫拿不到本次调用的检查结果就拒绝。AC-3 的网络各项要加一个场景：另装一个测试插件，它的 pre-execute 监听器 prepend 后直接返回 allow，web_fetch 访问 127.0.0.1 仍然被拒。
  - id: F-2
    severity: blocking
    text: agent-instructions 会把 Local 能写的文件当成 Global 的指令加载，共三条路。第一，$DSH_AGENTS_HOME/AGENTS.md，默认 ~/.agents，与 DSH_HOME 无关，文件名固定（agent-instructions lib/index.js:168）。第二，对 cwd 下的文件调用 read、write、edit 之后，从 cwd 到该文件之间每一层目录里的候选文件都会被加载（lib/index.js:1210、1052），所以镜像里的 AGENTS.md，或 Local 提交进仓库的 LG-ROLE.md，都会进入 Global 的上下文。第三，localInstructionFileCandidates 默认是 AGENTS.local.md 和 CLAUDE.local.md。结果是被审的一方能写审核者的指令。这是 docs/implementation.md 原设计的缺陷，那一段是我写的。要求：Global 的指令只能来自 lg-global 自己提供的角色文件，其他来源一律不加载。验收用金丝雀：在 ~/.agents/AGENTS.md 和被镜像仓库的子目录里放带标记的 AGENTS.md、AGENTS.local.md、LG-ROLE.md，同步并 read 该子目录下的文件后，Global 会话里不出现标记；对照是 lg-global 的角色文件确实出现在会话里。
  - id: F-3
    severity: blocking
    text: preset 断言的主体应当是注册表里只有 lg-global，而不是 defaultId。select 是远程方法（preset-registry lib/index.js:398），Web 界面可以在新会话的第一轮之前把它切到任何已注册的 preset；selectedDefault 也由界面写入。只要别的 preset 还在注册表里，断言 defaultId 挡不住。另外，“inspectCompositions 在没有会话时恒为空”这个结论不成立：探针传入的是插件自己的 ctx，按实现（lib/index.js:559）这样必然返回空；组合是在 preset 注册时就激活的（lib/index.js:495），不带参数调用会返回所有已激活 preset 的组合，可以用于启动断言。
  - id: F-4
    severity: minor
    text: 0026 的 evidence 列了 evidence/M2/probe-boot.log，但 478bd09 里没有这个文件。
---
P2 的探针本身做对了：四个接口的源文件路径和行号，我用 npm 上 0.2.1-rc.2 的包逐一核对过，都对得上。出问题的是从探针得出的结论，F-1 到 F-3 都会改变实现。

0026 提出的两处调整：第一处采纳，但改成按 F-3 断言注册表；第二处不采纳，理由见 F-3。启动时断言 list() 恰好只有 lg-global、没有 broken，再核对 inspectCompositions() 给出的组合；每个新会话在它的第一次工具调用执行之前再复核一次，不能等到下一次 lg_repo_sync。

另外两点：

- agent-instructions 不是只能靠真实会话核实：这个包导出了 discoverBaselineInstructionFiles 和 loadBaselineInstructions，注入的指令也会以 source.kind 为 agent-instructions 的消息出现在会话记录里。
- AC-3 的证据必须是真实 Global 会话里的工具调用事件，和 0019 那份一样。插件内部直接调用 ctx.tools.execute 只能算探针，不能算验收。

F-1、F-2、F-3 先改 docs/implementation.md，我审 diff。lg-scope 的路径守卫和 lg-repo 不受影响，可以照常推进。
