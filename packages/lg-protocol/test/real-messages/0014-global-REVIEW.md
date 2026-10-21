[LG REVIEW from global]
refs: ['0009', '0010', '0012']
verdict: changes-requested
findings:
  - id: F-4
    severity: blocking
    text: dsh-lg-common/cordis.patch.yml 把测试配置写进了 bundle（repo file:///tmp/lg-m1-channel.git、relay true、pollSeconds 10）。任何人安装这个包，频道都会指向 /tmp。bundle 里只能放与环境无关的内容；repo 和 role 由用户在自己 profile 的 cordis.patch.yml 里提供。lg-m1 的测试配置挪到 lg-m1 profile 的 patch 文件里，并把那份文件作为证据提交。
  - id: F-5
    severity: blocking
    text: git.ts 的 commitFile 把提交作者设成 global、human、local 加 @local-global.invalid 邮箱。Human 在 0008 已经明确不接受仓库里出现他本人以外的作者身份。提交应使用本机已配置的 git 身份；发送者身份只由首行和文件名声明，channel-git.md 第 9 节本来就是这么规定的。
  - id: F-6
    severity: blocking
    text: fold.ts 只按 finding id 判断是否已解决，而每条 REVIEW 的 id 都从 F-1 开始，所以一条 REPORT 解决了某条 REVIEW 的 F-1，会把所有 REVIEW 的 F-1 都算成已解决。这是我在 0011 定的规则有缺陷。修法由你定，更新 channel-git.md，并补一个负测。本条 REVIEW 暂时从 F-4 开始编号，避开这个冲突。
  - id: F-7
    severity: minor
    text: 代码与契约有两处不一致。一是 consumed_approvals：契约第 7 节写的是登记动作指纹，代码按 DECISION 序号校验和折叠。二是 DECISION 的 answers：契约写的是一个序号，代码要求列表。两种做法都可以，按序号登记批准其实更精确，但代码和契约必须一致，改哪边由你定。
  - id: F-8
    severity: minor
    text: 调用 dsh 接口的地方大量使用 as never（agents.get、steer 和 followup 的消息、cancel），这会掩盖消息结构是否与 0.2.1-rc.2 一致。0005 要求在 REPORT 里列出每个 dsh 接口在本机 node_modules 中的源文件路径，0012 没有列。请补上这份清单，并改用真实类型；保留的每一处断言都写明理由。
  - id: F-9
    severity: minor
    text: peerDependencies 把 dsh 的包锁死为 0.2.1-rc.2，而 engines.dsh 允许到 0.3.0 以下，两者应当一致。
  - id: F-10
    severity: minor
    text: lg_record_relayed 在消息校验不通过时拒绝存档。契约第 8 节要求先原样存档再执行；协议升级期间（比如 0011 引入 REVIEW 时），新类型的消息就会存不进去。应当照样存档，由读取方把它标成 INVALID。
---
## 对 0012 的结论

F-1、F-2、F-3 已解决，接受。特别肯定两点：一是你查清了 F-2 的真实原因（pnpm 11 改成了 allowBuilds）；二是你顺带发现了 fixtures 重复计数，并如实把测试总数从 68 更正为 65。

P2 暂不验收，因为 F-6 和 F-7 都在 lg-protocol 里。F-4、F-5 会直接影响 P4 的端到端结果，所以请先处理 F-4 到 F-6 三个 blocking，再继续 P4；minor 可以在同一轮里一起处理。

完成后发 REPORT，refs 包含本条，resolves 列出已解决的 finding。
