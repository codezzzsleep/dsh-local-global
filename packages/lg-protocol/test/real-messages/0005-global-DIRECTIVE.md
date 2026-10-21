[LG DIRECTIVE from global]
refs: ['0002', '0004']
version: 1
goal: 完成里程碑 M1：lg-protocol、lg-channel（git 后端）、lg-commands，并在本机 dsh 0.2.1-rc.2 上真实运行通过。
priorities:
  - P1 应用 0004 补丁；此后一切以补丁后的 docs/ 为准，尤其是 docs/channel-git.md
  - P2 lg-protocol 及其单元测试
  - P3 dsh-lg-common 包里的 lg-channel 和 lg-commands 两个插件
  - P4 在真实 dsh 上做端到端验证
scope:
  in:
    - 应用 0004 补丁
    - packages/lg-protocol
    - packages/dsh-lg-common，只含 lg-channel、lg-commands 两个插件
    - 用本机 bare 仓库 /tmp/lg-m1-channel.git 作为测试频道
  out:
    - lg-local、lg-global 两个包的任何内容（属于 M2、M3）
    - npm 发布
    - 用新插件接管真实频道仓库 local-global-channel（M1 之后再定）
acceptance:
  - id: AC-1
    text: 0004 用 git am 应用，提交作者保持为 Global；三个文件的 sha256 与 0004 列出的完全一致
  - id: AC-2
    text: pnpm -r test 全部通过；输出存为 evidence/M1/test.txt；必须包含正文“测试要求”一节列出的全部负测
  - id: AC-3
    text: dsh-lg-common 可以用 dsh plugin add 装进 profile lg-m1、用 dsh plugin remove 卸掉；装前、装后、卸后三份 --dump-config 输出作为证据
  - id: AC-4
    text: 正文“端到端验证”一节的 E1 至 E8 全部在真实 dsh 上通过，每项都有原始证据
  - id: AC-5
    text: evidence/M1/README.md 逐项列出 AC-1 至 AC-4 的证据文件、执行命令、环境（real 或 simulated）和结果
---
## 对 0002 三处疑问的决定

三处都成立，全部采纳，已由 0004 补丁改进文档：

1. 不变量 7 改为“隔离由代码强制，不靠模型自觉”。默认是插件层强制，系统层隔离仍是可选增强，不提为 v0.1 必需；反向隔离在插件层只做检测。
2. 新增 STATUS 类型做心跳；预算定为 max_hours 和 max_rounds，由各侧插件自己计量。M1 不要求实现 STATUS 和预算。
3. 去掉单独的频道服务，频道改为 git 仓库，契约全文见 docs/channel-git.md。M1 的 lg-channel 就按它实现。

另外请在下一条 REPORT 附上 `gh repo view codezzzsleep/dsh-local-global --json repositoryTopics` 的输出。topics 我在我这边核验不了。

## 仓库布局（M1 结束时）

```text
dsh-local-global/
├── package.json            name: dsh-local-global，private: true，packageManager: pnpm@11.28.5
├── pnpm-workspace.yaml     packages: ['packages/*']
├── tsconfig.base.json      strict: true，target: ES2022，module: NodeNext
├── packages/
│   ├── lg-protocol/        包名 @local-global/lg-protocol（普通库）
│   │   ├── src/
│   │   └── test/
│   └── dsh-lg-common/      包名 @local-global/dsh-lg-common（dsh bundle）
│       ├── cordis.patch.yml
│       ├── src/
│       └── test/
└── evidence/M1/
```

- 语言 TypeScript，测试框架 vitest，构建用 tsc 输出到各包的 lib/。
- dsh-lg-common 的 package.json：`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`；`"engines": {"dsh": ">=0.2.1-rc.2 <0.3.0"}`；`exports` 提供 `./channel` 和 `./commands` 两个入口。
- dsh 自己的包（cordis、schemastery、tools 等）同时写进 peerDependencies 和 devDependencies，做法按 dsh 的 publish 文档。包名和版本以你本机 dsh 安装里实际存在的为准。
- cordis.patch.yml 插入两行：id `lg-channel`，name `@local-global/dsh-lg-common/channel`；id `lg-commands`，name `@local-global/dsh-lg-common/commands`。

## lg-protocol 要提供的接口

全部按 docs/channel-git.md 实现：

- `parseMessage(filename, text)`：解析首行、字段区和正文，返回成功结果或错误列表
- `validateMessage(message)`：校验类型的发送者权限、必填字段，以及文件名与首行是否一致
- `formatMessage(message)`：生成文件名和文件内容
- `nextSeq(filenames)`：取下一个序号
- `foldState(messages)`：折叠出当前 DIRECTIVE、未关闭问题、可用批准
- `actionFingerprint(ruleId, command)`：计算动作指纹
- 序号不大于 0002 的历史消息按 channel-git.md 第 10 节跳过校验

## lg-channel 与 lg-commands

- lg-channel 的配置字段与默认值：`repo`（必填），`branch`（main），`role`（必填，local 或 global），`pollSeconds`（60），`relay`（false），`cloneDir`（默认放在 DSH_HOME 下的 lg/ 目录）。
- 行为与工具（lg_post、lg_record_relayed、lg_read、lg_open_questions）按 docs/implementation.md 的“频道插件”一节和 docs/channel-git.md 实现。
- lg-commands 提供三个命令：
  - `/lg-bind`：把当前会话设为本侧唯一的投递目标
  - `/lg-status`：显示绑定的会话、游标、频道最大序号、未关闭问题
  - `/lg-halt <原因>`：以 human 身份写一条 HALT
- 所有用到的 dsh 接口（投递消息、注册工具和命令、读写存储等），都要在 REPORT 里写明它在你本机 node_modules 中的源文件路径。你本机的版本是 0.2.1-rc.2，我手上的文档是 master 分支的，以你本机为准。

## 测试要求（AC-2）

单元测试必须包含以下负测：

1. 首行格式错误的消息被拒
2. 文件名中的发送者或类型与首行不一致被拒
3. 每种类型至少一个“缺必填字段被拒”的用例
4. 角色越权被拒：local 发 DIRECTIVE、global 发 REPORT
5. 序号跳号或重复被识别
6. DECISION 回答之后，对应 QUESTION 不再出现在未关闭列表
7. 批准登记进 consumed_approvals 之后，不能再次使用

另外写一个针对真实 git 的集成测试：两个写入者同时向同一个 bare 仓库写消息，后 push 的一方必须重新取号并成功，最终序号连续不重复。

## 端到端验证（AC-4）

环境：本机真实 dsh 0.2.1-rc.2，测试频道 `/tmp/lg-m1-channel.git`，profile `lg-m1`。用 `dsh --profile lg-m1 --from-default-profile web` 创建这个 profile；如果 0.2.1-rc.2 没有这个参数，先发 QUESTION，不要自己换别的办法。

lg-channel 在 lg-m1 里配置为：repo `file:///tmp/lg-m1-channel.git`，role `local`，pollSeconds `10`，relay `true`。启动后新建会话并执行 `/lg-bind`。

| 编号 | 操作 | 期望结果 | 证据 |
| --- | --- | --- | --- |
| E1 | 用脚本向测试频道提交一条合法的 `0002-global-DIRECTIVE.md` | 30 秒内绑定会话收到带 `[LG #0002 DIRECTIVE v1 from global]` 标签的消息 | 会话记录导出或截图，以及脚本的提交时间 |
| E2 | 让会话用 lg_post 发一条 REPORT | 频道出现 `0003-local-REPORT.md`，提交信息为 `msg 0003 local REPORT` | `git log` 与文件内容 |
| E3 | 让会话用 lg_post 发一条 DIRECTIVE | 工具拒绝，说明是角色越权 | 工具调用结果 |
| E4 | 用脚本提交一条缺 version 的 `0004-global-DIRECTIVE.md` | 会话收到 `[LG INVALID #0004]` 提示，而不是原文 | 会话记录 |
| E5 | 重启 dsh | 0002 和 0004 不被重复投递 | 重启后的会话记录 |
| E6 | 会话正在运行时，用脚本提交一条 `human` 的 HALT | 当前回合被中止，之后不再投递 | 会话记录 |
| E7 | 在界面执行 `/lg-halt 测试` | 频道出现一条 `human` 的 HALT，内容含原因 | `git log` 与文件内容 |
| E8 | 把一段 Global 消息全文交给会话，让它用 lg_record_relayed 存档 | 存档文件与输入逐字节一致 | 输入与文件各自的 sha256 |

E1 至 E8 要按顺序做；任何一项失败，就先发 REPORT 报告第一个失败的现象和原始日志，不要绕过它继续做后面的项。

## 汇报节奏

- P1 到 P4 每完成一项，发一条 REPORT，`directive_version` 写 1。
- 从现在起，你发的消息都按 docs/channel-git.md 的格式写：首行、YAML 字段区、`---`、正文。REPORT 必须带 `refs`、`commit`、`directive_version`、`evidence`、`negative_tests` 五个字段，没有的写空列表。
- 本指令范围内没有需要批准的 C 类动作。npm 发布和 force push 一律不做。
