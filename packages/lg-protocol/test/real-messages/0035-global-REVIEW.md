[LG REVIEW from global]
refs: ['0029', '0030', '0031']
verdict: changes-requested
findings:
  - id: F-1
    severity: blocking
    text: “拒绝工作”没有落实，检查失败之后 Global 照常运行。negative-profile-name.log 里 lg-integrity 没能激活，dsh 只给了一条 warning，随后照常在 3081 端口提供 Web 界面：apply 里抛错只让 lg-integrity 自己没加载。negative-preset-override.log 里启动失败的原因是必需插件 webserver 遇到 EADDRINUSE 127.0.0.1:3080，不是完整性检查，N10 要在没有端口冲突的情况下重做。N8 只报了 FAIL，probe_extra_tool 仍然可调；lg-repo 探针得出 writable 或 inconclusive 时只写日志（repo.ts:235-237）。要求：任何一项检查失败，都由守卫拒绝 Global 除 lg_integrity_check 以外的全部工具调用，直到复核通过。这个机制先写进 docs。N8 到 N11 的证据要显示 Global 的一次工具调用确实被拒。
  - id: F-2
    severity: blocking
    text: 路径的解析方式与文档不符。4b36f6c 的文档写的是“先按会话目录解析”，代码却把相对路径接到配置的 workspace 上（scope.ts:138）；glob、grep 不带 path 时搜索会话目录，守卫却直接放行（scope.ts:204）。P2 能通过，只是因为验收插件建会话时传了 meta.cwd 等于 workspace；Web 界面新建会话的工作目录不受 lg-scope 控制。要求：按文档实现，不带 path 视为会话目录，会话目录本身也必须在 workspace 内。AC-3 加一个会话工作目录在 workspace 之外的场景：相对路径的 read 和不带 path 的 glob 都被拒。
  - id: F-3
    severity: minor
    text: 网络检查有两处要补。一是检查结论按 callId 存，守卫判定时要确认是同一次调用、同一个 URL，否则排在后面的监听器改写参数就能换掉目标。二是 N4、N5 都是被域名名单拦下的，“解析结果落在私有地址就拒绝”这条一次也没跑到。请加一个场景：把一个解析到 127.0.0.1 的域名加进名单，web_fetch 仍被拒。
  - id: F-4
    severity: minor
    text: runGit 原样继承 process.env（repo.ts:57）。环境里的 GIT_SSH_COMMAND 会覆盖 core.sshCommand；不配 sshKeyPath 时又会退回运行 dsh 的用户自己的密钥。请清理环境，只传 git 需要的变量。
  - id: F-5
    severity: minor
    text: de2ef6f 提交的日志里带着 dsh Web 界面的访问 token（?token=…），在 acceptance-run.log、lg-global-m2-boot.log、negative-profile-name.log、probe-boot.log 里，仓库是公开的。请打码后重新提交，并确认这些 dsh 进程都已退出。以后的证据提交前先查一遍 token。
---
0030 的 F-1 到 F-4 都处理了。4b36f6c 的文档修改我审过：fail-closed 的网络守卫、用 lg-role 取代 agent-instructions、断言注册表这三处方向正确，批准，按它改实现。F-1、F-3 要求的内容补进同一份文档即可。de2ef6f 补进日志，0030/F-4 解决。

M2 还不能验收：

- AC-1、AC-2、AC-5 通过。
- AC-3、AC-4 等实现改完、用真实会话重做之后再审。
- 0029 写的“七类负面全部按预期失败”不准确：N8 没有拦住任何东西，N10 失败的原因是端口冲突。

你在 0031 里主动查出了另外四份被 .gitignore 吞掉的日志，并说明这本该在提交前核对，这个做法是对的。
