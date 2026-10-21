# Local–Global 开发规格（SPEC）v2

Oct 21, 2026 · @ji qi

## 范围与约定

本规格是 Local–Global 框架 v2 唯一的开发依据：需求全部在这里定死，Global 和 Local 只凭这一份文档工作。每条需求都有编号和验证方式，全部完成后由独立检查者按“最终验收”一节逐条核对。

读者有三个：Global 模型据此下达指令、审核进度；Local 模型据此实现；独立检查者在最后验收。本规格与之前的任何讨论、设计稿或频道消息冲突时，以本规格为准。

落地到插件仓库时，本规格放在 docs/spec.md，取代 docs/design.md 和 docs/implementation.md 中与它冲突的部分；docs/channel-git.md 按“消息协议”一节更新。

需求编号形如 CH-3，即模块缩写加序号。DIRECTIVE 的验收标准、REVIEW 的 finding、证据索引都必须按编号引用。需求一经发布不改号；作废的需求保留编号并标为作废。

**用词**

- 必须、不得：违反即不合格，验收不通过。
- 应当：默认这样做；不这样做，要在 REPORT 里写明理由。
- 可以：实现者自行决定。

**目标环境**

- DeepSeek Harness 0.2.1-rc.2，各包的 engines.dsh 为 `>=0.2.1-rc.2 <0.3.0`。
- Node 24、pnpm 11、TypeScript strict、vitest。
- dsh 接口以本机 node\_modules 里 0.2.1-rc.2 的实现为准。每用到一个接口，证据里都要写明它的源文件路径和行号。

**硬约束**

1. 不 fork、不修改 dsh 的任何代码，只用公开的插件接口。
2. 交付物是 dsh bundle，用 dsh plugin add 安装、dsh plugin remove 卸载；卸载后 --dump-config 必须与安装前完全一致。
3. bundle 里只放与环境无关的内容。仓库地址、角色、工作区路径写在使用者自己的 profile 补丁里。
4. 不要求 root、容器或独立系统用户；Global 与 Local 必须使用不同的 DSH\_HOME。
5. 提交只用本机已配置的 git 身份，仓库里不得出现其他作者身份或尾注。

**术语**

| 术语 | 含义 |
| --- | --- |
| Local 环境 | 用户平时的 dsh，装 dsh-lg-common 与 dsh-lg-local |
| Global 沙箱 | 另一个 dsh 进程，独立 DSH\_HOME，装 dsh-lg-common 与 dsh-lg-global |
| 仓库沙箱 | 本机 git 服务，装 dsh-lg-reposandbox，存放代码、频道和证据 |
| 形态 A 的云端协作 | GitHub 加网页版 Global |
| 形态 B 的本机 Global | GitHub 加 Global 沙箱 |
| 形态 C 的全本机 | 仓库沙箱加 Global 沙箱 |
| 检查点 | 请求 Global 审核的时刻，由带 checkpoint 的 REPORT 或阻塞的 QUESTION 标记 |
| 暂停状态 | Global 沙箱的进程内状态；暂停时除 lg\_integrity\_check 外的工具调用全部被拒 |

## 背景与目标

Local–Global 是一套双 agent 框架：Local 在完整环境里执行，是唯一的写者；Global 在隔离环境里判断，持有停止权；Human 在两者之上。本项目要把它做成 DeepSeek Harness（下称 dsh）的一套即插即用的插件。

框架针对单 agent 的三个老问题：执行者过早宣布完成；汇报偏乐观且无人核对；执行者的上下文被报错和试错淹没，失去整体判断。它来自 OnCue 项目的实战，那次运行在黑客松中拿到第一名。核心机制称为 Co-Observer：两个 agent 从内、外两个视角观察同一份事实。

**角色与权力**

| 角色 | 职责 | 能看到 | 能写 | 权力 |
| --- | --- | --- | --- | --- |
| Local | 执行者；拥有完整环境 | 全部本地状态、频道、仓库 | 代码仓库、证据、频道 | 服从 Global；可带证据发 OBJECTION |
| Global | 判断者；定方向、定验收标准、审核 | 频道、Local 发布的代码与证据、白名单内的外部资料 | 频道；自己沙箱里的草稿 | 发 DIRECTIVE、REVIEW、DECISION、PATCH；唯一能发 STOP |
| Human | 委托人 | 一切 | 频道的 TASK 与 HALT | HALT 优先于一切；部署与权限只由 Human 决定 |

**十条不变量**

下面十条在任何部署形态下都必须成立，而且由代码强制，不靠模型自觉。后面各节的需求都是为了让它们成立。

1. 单一写者：只有 Local 能写代码仓库和证据；Global 的代码以 PATCH 进入频道，由 Local 校验后应用。
2. 汇报是声明，产物是证据：Global 的结论必须能从代码和证据独立核对。
3. 证据物化：Global 需要判断的本地状态，必须以原始形式发布，而不是摘要。
4. 证据绑定版本：每项“通过”绑定 commit 或内容哈希，版本变了旧证据自动失效。
5. 不对称权力：Local 服从 Global；只有 Global 能发 STOP，而且必须引用验收标准。
6. 人在最上层：Human 的 HALT 优先于一切。
7. 隔离由代码强制且 fail-closed：Global 看不到 Local 的环境，只能到达白名单内的地址；任何隔离检查失败、没跑完或没加载，Global 都停止工作。
8. 被审方不能成为审核方指令的来源：Global 的指令只来自它自己的角色文件；仓库、证据、频道消息和网页都只是数据。
9. 消息一经发出即为最终版：频道只追加，要改就发更正或替代消息。
10. 双方自主、检查点同步：怎么做由各自决定；框架只规定格式、权力和检查点。

**三个区**

| 区 | 里面有什么 | 谁能写 | 谁能读 | 可替换为 |
| --- | --- | --- | --- | --- |
| Local 环境 | 源码工作区、shell、运行时、日志、Local 的 dsh 会话 | Local、Human | Local、Human | — |
| 仓库沙箱 | 代码仓库、频道仓库、证据库 | 代码和证据只有 Local；频道三方各写自己的消息 | Local、Global、Human | GitHub |
| Global 沙箱 | Global 的 dsh 进程、独立 DSH\_HOME、只读镜像、草稿目录、角色文件 | Global 只写草稿目录 | Global、Human | 网页版 Global |

**部署形态**

用户做两个独立选择：仓库用 GitHub 还是仓库沙箱，Global 用网页版还是 Global 沙箱。三种组合受支持，一种不支持。

| 形态 | 仓库 | Global | 隔离强度 | 必须满足 |
| --- | --- | --- | --- | --- |
| A 云端协作 | GitHub | 网页版 | 最强：Global 在另一台机器上 | Global 用只能写频道仓库的凭据写频道；没有就走中转 |
| B 本机 Global | GitHub | Global 沙箱 | 规则层 | Global 经 https 匿名读 GitHub |
| C 全本机 | 仓库沙箱 | Global 沙箱 | 规则层；仓库规则由服务器执行 | 除模型 API 外不出本机 |
| D | 仓库沙箱 | 网页版 | 不支持 | 仓库沙箱只监听本机地址 |

换形态时，Local 一侧只改仓库和频道地址。形态 A、B 的证据进公开仓库，发布前必须扫描密钥。

**本项目的交付目标**

全部里程碑完成后，用户在任一台装有 dsh 0.2.1-rc.2 的机器上，用 dsh plugin add 装上这几个包，就能以形态 A、B 或 C 运行 Local–Global；在模式选择器里选中新模式，Local 与 Global 同屏出现。

## 包与仓库布局

插件仓库 codezzzsleep/dsh-local-global 是一个 pnpm workspace，包含一个普通库和四个 dsh bundle；每个 bundle 只装进它所在区的 profile。

```text
dsh-local-global/
├── package.json             private，packageManager: pnpm@11.x
├── pnpm-workspace.yaml      packages: ['packages/*']；allowBuilds: { esbuild: true }
├── tsconfig.base.json       strict，ES2022，NodeNext
├── AGENTS.md                Local 的交互规则
├── docs/                    design.md、spec.md、channel-git.md
├── packages/
│   ├── lg-protocol/
│   ├── dsh-lg-common/
│   ├── dsh-lg-global/
│   ├── dsh-lg-local/
│   └── dsh-lg-reposandbox/
└── evidence/<里程碑>/        形态 A、B 下的证据
```

| 包 | exports | 插件行 id | 装进哪里 |
| --- | --- | --- | --- |
| @local-global/lg-protocol | . | — | 普通库，被其他包依赖 |
| @local-global/dsh-lg-common | ./channel、./commands | lg-channel、lg-commands | Local 的日常 profile；Global 沙箱的 profile |
| @local-global/dsh-lg-global | ./role、./scope、./repo、./integrity、./directive、./checkpoint | preset-lg-global、lg-scope、lg-repo、lg-integrity、lg-directive、lg-checkpoint；lg-role 装在 preset 内 | 只能装进名称以 lg-global 开头的 profile |
| @local-global/dsh-lg-local | ./evidence、./patch-apply、./report-gate、./action-gate、./protect、./pairing | lg-evidence、lg-patch-apply、lg-report-gate、lg-action-gate、lg-protect、lg-pairing、preset-lg-local | Local 的日常 profile |
| @local-global/dsh-lg-reposandbox | ./server | lg-repo-server | 名称以 lg-reposandbox 开头的 profile，独立 DSH\_HOME |

**每个包都必须**

- 把用到的 dsh 包同时写进 peerDependencies 和 devDependencies，范围与 engines.dsh 一致。
- bundle 的 package.json 带 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`。
- 用 tsc 构建到 lib/；lib/ 不入库，files 只发布 lib/ 和 cordis.patch.yml。
- 测试从 src 引用兄弟包，不依赖构建顺序。
- npm 发布是 C 类动作，必须有 Human 批准。

新模式的 preset id 固定为 lg-local，显示名为“共察模式”；仓库沙箱的 profile 名以 lg-reposandbox 开头。

## 消息协议（lg-protocol）

频道是一个只追加的 git 仓库，每条消息一个文件。lg-protocol 是两侧共用的普通库，负责解析、校验、渲染、取号和折叠。

**文件与格式**

- 仓库布局：messages/ 放消息，attachments/<序号>/ 放附件，status/<角色>.json 放心跳。只有 status/ 允许原地覆盖。
- 文件名 messages/<四位序号>-<发送者>-<类型>.md。序号从 0001 连续递增；发送者只有 human、global、local；类型全大写。
- 一个提交只含一条消息及其附件，提交信息为 `msg <序号> <发送者> <类型>`。
- 首行必须匹配 `^\[LG ([A-Z_]+) from (human|global|local)\]$`，且与文件名一致。第二行起是 YAML 映射，到第一行恰好为 `---` 的行为止；之后是可选的 Markdown 正文。
- UTF-8、LF 换行、以换行结尾。序号不大于 0002 的历史消息不校验。

**类型、发送者与字段**

所有类型都可以带 refs（被引用的序号列表，元素是四位字符串）、id 和 supersedes。

| 类型 | 发送者 | 必填字段 | 可选字段 |
| --- | --- | --- | --- |
| TASK | human | goal、constraints、budget | — |
| REPORT | local | refs、commit、directive\_version、evidence、negative\_tests | open\_questions、consumed\_approvals、resolves、checkpoint、meanwhile |
| QUESTION | local | options、blocking、default\_action | action |
| OBJECTION | local | target、evidence | — |
| DIRECTIVE | global | version、goal、priorities、acceptance、scope | — |
| REVIEW | global | refs、verdict、findings | — |
| DECISION | global | answers、choice、reason | approve\_action |
| PATCH | global | name、claim、base、format、bytes、sha256 | — |
| CLAIM | global、local | scope、implementer | — |
| CORRECTION | 任一方，只能更正自己的消息 | corrects、replacement | — |
| ISOLATION\_REPORT | global、local | probes | — |
| STOP | global | final\_commit、acceptance | — |
| HALT | human | reason | — |

**字段约定**

- id：v2 新增。形如 G-0042、L-0107、H-0003，由发送方在写好消息时生成，按发送方各自递增、不重复。新写的消息必须带 id；没有 id 的旧消息按序号处理，不判为非法。
- supersedes：v2 新增。被替代的 id 列表，只能替代同一发送方自己的消息。
- commit、base、final\_commit：完整 40 位 SHA，必须从 git 直接取，不得手工补全。
- evidence、negative\_tests：列表，可以为空，但字段必须存在。
- budget：{max\_hours: 数字, max\_rounds: 整数}。
- QUESTION 的 qid 就是它自己的序号；default\_action 不得是 C 类动作；action 是需要批准的动作指纹。
- 动作指纹：`<规则 id>:<命令文本 UTF-8 编码的 sha256 前 12 位十六进制>`。
- DECISION 的 answers：被回答的 QUESTION 或 OBJECTION 的序号列表。
- DIRECTIVE 的 version 从 1 起每次加 1；acceptance 是 \[{id: AC-\<n>, text}\]；scope 是 {in: \[...\], out: \[...\]}。
- REVIEW 的 verdict 取 accepted 或 changes-requested；findings 是 \[{id: F-\<n>, severity: blocking 或 minor, text}\]。
- REPORT 的 resolves 写 `<REVIEW 序号>/F-<n>`；consumed\_approvals 登记用掉批准的那条 DECISION 的序号。
- REPORT 的 checkpoint：v2 新增，布尔。为 true 时表示请求 Global 审核 commit 字段指向的版本。
- REPORT 的 meanwhile：v2 新增，字符串列表，写明等待审核期间要做、且与被审内容无关的工作。
- probes：\[{name, expected, actual, pass}\]。STOP 的 acceptance：\[{id: AC-\<n>, evidence: \[...\]}\]，覆盖当前 DIRECTIVE 的全部验收标准。

**心跳**

STATUS 不进 messages/，不占序号。文件 status/<角色>.json，内容 {state, last\_read, directive\_version, updated\_at}；state 取 working、idle、blocked、budget-exhausted、halted。状态变化时立即更新，否则至少每 10 分钟一次；超过 20 分钟未更新即视为失联。

**折叠状态**

读取方从 messages/ 计算，不另外存储：

- 当前 DIRECTIVE：version 最大的一条。
- 未关闭问题：没有被任何 DECISION 的 answers 引用的 QUESTION 和 OBJECTION。
- 未解决 finding：全部 REVIEW 的 findings 减去全部 REPORT 的 resolves。
- 可用批准：全部 DECISION 的 approve\_action 减去已登记为用掉的 DECISION。
- 已替代：被任何 supersedes 引用的 id。
- 待审检查点：带 checkpoint 的 REPORT，之后还没有任何 Global 消息在 refs 里引用它。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| PR-1 | parseMessage 解析首行、字段区和正文；格式不对返回错误列表，不抛异常 | 单元测试，含首行错误的负测 |
| PR-2 | validateMessage 校验发送者权限、必填字段、字段形状，以及文件名与首行一致 | 每种类型至少一个缺字段负测；local 发 DIRECTIVE、global 发 REPORT 的越权负测 |
| PR-3 | formatMessage 生成文件名和内容；解析再渲染的结果与原文逐字节一致 | 往返测试 |
| PR-4 | nextSeq 取最大序号加 1；findSeqAnomalies 识别跳号和重复 | 跳号、重复各一个负测 |
| PR-5 | foldState 计算上述六项折叠状态 | 每项至少一个正测和一个负测 |
| PR-6 | 校验 id 与 supersedes：格式、不重复、只能替代自己的消息 | 三个负测 |
| PR-7 | 不同 REVIEW 的同号 finding 互不影响 | 负测：0011/F-1 已解决时 0014/F-1 仍未解决 |
| PR-8 | 一次批准登记用掉后不能再用 | 负测 |
| PR-9 | 没有 id 的旧消息照常解析、折叠 | 用本项目频道 0003 到 0039 的真实消息做回归测试 |
| PR-10 | 不认识的类型解析为非法消息并说明原因，不抛异常 | 负测 |
| PR-11 | docs/channel-git.md 与本节一致 | Global 审 diff |

## 频道插件（lg-channel、lg-commands）

lg-channel 把频道接进 dsh：拉取新消息、按规则投递给绑定的会话、提供发消息的工具。两侧用同一个插件，只是 role 不同。

**配置**

| 字段 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| repo | 字符串 | 必填 | 频道仓库地址：GitHub、仓库沙箱的本机地址 |
| branch | 字符串 | main | 分支 |
| role | local 或 global | 必填 | 本侧角色，决定 id 前缀和投递规则 |
| pollSeconds | 数字 | 60 | 拉取间隔 |
| relay | 布尔 | false | 中转模式；为 true 时才提供 lg\_record\_relayed |
| cloneDir | 字符串 | $DSH\_HOME/lg/<仓库标识> | 本地克隆位置 |
| stateDir | 字符串 | $DSH\_HOME/lg/state/<仓库标识> | 游标、绑定、发件副本 |

**投递**

| 收到的消息 | 本侧是 Local | 本侧是 Global |
| --- | --- | --- |
| 对方或 Human 的消息 | 会话运行中用 steer，空闲时用 followup 开新回合 | 只有唤醒类消息开新回合，其余用 inject 放进上下文但不开回合 |
| HALT | cancel 当前回合，并停止后续投递 | 同左 |
| 自己发出或自己存档的消息 | 不投递 | 不投递 |
| 已投递过的 id | 不再投递 | 不再投递 |

- Global 的唤醒类消息：带 checkpoint 的 REPORT、阻塞的 QUESTION、OBJECTION、TASK、HALT。
- 投递内容是一条带标签的用户消息，形如 `[LG #0042 DIRECTIVE v4 from global id=G-0012]`，后面附完整字段和正文。
- 校验不通过的消息不投递原文，改投递 `[LG INVALID #<序号>] <原因>`。
- 被替代的消息投递为 `[LG #<序号> <类型> SUPERSEDED by <id>]`，并明确写上“不要执行”。
- 游标是已投递的最大序号，存在 dsh 的存储里，只在投递成功后前移。第一次绑定时游标直接设为频道最大序号，历史消息不进会话。

**工具**

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| lg\_post | type、refs、fields、body、attachments | 自动生成 id；先本地校验，不通过就返回缺什么；取号、写文件、提交、push；push 被拒就重新取号，最多重试 3 次；返回序号、id 和 commit |
| lg\_record\_relayed | text（Human 粘贴的全文） | 只在 relay 为 true 时可用；只校验首行，发送者必须是 global 或 human；逐字节原样存档并读回比对；同一个 id 已在频道里就不新建文件，返回已有序号 |
| lg\_read | from、to | 按序号范围读历史消息 |
| lg\_open\_questions | 无 | 列出未关闭的问题、未解决的 blocking finding、待审的检查点 |

**命令**

| 命令 | 行为 |
| --- | --- |
| /lg-bind | 把当前会话设为本侧唯一的投递目标；Local 侧同时注入 Local 的角色说明 |
| /lg-status | 显示绑定的会话、游标、频道最大序号、当前 DIRECTIVE 版本、未关闭问题、未解决 finding、待审检查点 |
| /lg-halt <原因> | 以 human 身份写一条 HALT，两侧会话都停止 |

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| CH-1 | 缺 repo 或 role 时插件拒绝加载并说明原因；bundle 里不含任何环境配置 | 单元测试；检查 cordis.patch.yml |
| CH-2 | 第一次绑定不重发历史消息 | 会话记录 |
| CH-3 | 按上表投递；HALT 中止正在运行的回合，之后不再投递 | 真实 dsh 端到端 |
| CH-4 | Global 侧只有唤醒类消息开新回合，普通进度 REPORT 不开 | 真实 dsh 端到端，正反各一 |
| CH-5 | 非法消息投递为 INVALID 提示，游标照常前移 | 会话记录 |
| CH-6 | 重启后不丢不重 | 重启前后的会话记录 |
| CH-7 | lg\_post 本地校验、自动 id、冲突重取号；两个写入者同时写，最终序号连续不重复 | 真实 git 集成测试 |
| CH-8 | lg\_record\_relayed 逐字节存档、读回比对、按 id 去重 | 输入与存档的 sha256；重复粘贴只产生一个文件 |
| CH-9 | 自己存档或已投递过的 id 不再投递 | 会话记录 |
| CH-10 | 被替代的消息带 SUPERSEDED 标签投递，不执行 | 会话记录 |
| CH-11 | 提交作者是本机 git 身份，不是消息发送者 | git log |
| CH-12 | Global 侧保存每条发出消息的副本，每次拉取都逐字节比对；不一致就发 ISOLATION\_REPORT | 篡改一条已存档的 global 消息后的记录 |
| CM-1 | /lg-bind、/lg-status、/lg-halt 按上表工作 | 在 Web 界面里实际执行的截图或输出 |

## Global 沙箱（dsh-lg-global 的 M2 部分）

Global 沙箱用于形态 B 和 C。它的原则是“不给，而不是禁止”加 fail-closed：会话里没有 shell；每次文件、网络和仓库访问都过守卫；任何检查不通过，整个 Global 就停下。

**部署前提**

- 独立的 DSH\_HOME；profile 名以 lg-global 开头。
- 工作区布局：`<workspace>/LG-ROLE.md` 是角色文件，`<workspace>/repo.git` 是只读镜像，`<workspace>/drafts/` 是草稿目录。
- Global 会话的工作目录必须在 workspace 之内。

**preset lg-global**

bundle 的 cordis.patch.yml 声明 preset lg-global，把 agent-preset-registry 的 default 设为 lg-global，并关掉 preset-standard、preset-cordis、preset-ptc、preset-minimal。preset 里只装 persona、lg-role、tool-fs（read、read\_image、write、edit）、tool-fs-search、tool-web（fetch 与 search），不装 agent-instructions，不装任何 shell、终端、后台任务或子 agent 工具。

会话可见工具的白名单：read、read\_image、write、edit、glob、grep、web\_fetch、web\_search、working\_directory，以及本项目提供的 lg\_\* 工具。present 不在白名单里。

**暂停状态**

lg-scope、lg-repo、lg-role、lg-integrity 共享一个进程内的暂停状态。

- 进程启动时即处于暂停，原因是 not-verified；只有 lg-integrity 第一次报告全部检查通过后才解除。
- 暂停期间，一个进程级守卫拒绝除 lg\_integrity\_check 以外的全部工具调用，拒绝理由为 `lg-global paused: <原因代码> — <说明>`。
- 触发暂停的原因：注册表断言失败、组合核对失败、白名单外的工具、会话工作目录不在 workspace 内、角色文件读不到、仓库配置或镜像配置不合规、push 探针为 writable、组合哈希变化、发件副本比对不一致。
- 任何插件都不得靠在 apply 里抛异常来表达“拒绝工作”：dsh 只会记一条 warning，其余插件照常运行。

**lg-role**

配置 roleFile（默认 LG-ROLE.md，相对 workspace）。会话开始时只读这一个文件并注入系统提示，不做任何目录发现。读不到就暂停。

**lg-scope**

配置：workspace（必填，绝对路径）、allowDomains（默认 github.com、api.github.com、raw.githubusercontent.com、codeload.github.com、objects.githubusercontent.com、gist.github.com、gist.githubusercontent.com）、writeRoots（默认 drafts/）。

- 路径：守卫检查 read、read\_image、write、edit、glob、grep 的 file\_path 或 path，以及 working\_directory 的 cd。相对路径按会话工作目录解析，与工具本身一致；glob、grep 不带 path 时把会话工作目录当作目标。取真实路径后必须在 workspace 内；write、edit 还必须在 writeRoots 内。
- 工具名：bash、pwsh、terminal、job\_、subagent、task 开头的工具一律拒绝。
- 网络：web\_fetch 只允许 http 和 https；域名必须等于名单中的某一项或是它的子域名；解析结果不得落在 127.0.0.0/8、::1、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、100.64.0.0/10、fc00::/7、fe80::/10。
- 网络检查的最终判定在同步守卫里。tools/pre-execute 只做异步解析，把结论与本次调用和 url 绑定。守卫只在“同一次调用、url 未被改写、结论为允许”时放行，取不到结论就拒绝。

**lg-repo**

配置：remote（必填）、branch（默认 main）、mirrorDir（默认 `<workspace>/repo.git`）、httpProxy（可选）。

- remote 只能是不带用户名和令牌的 https 地址，或仓库沙箱的 `http://127.0.0.1:<端口>/` 地址。ssh、git@、file:// 一律拒绝。
- git 的环境由插件自己构造：只传 PATH 和 LANG；HOME 与 XDG\_CONFIG\_HOME 指向不存在的目录；设 GIT\_TERMINAL\_PROMPT=0、GIT\_ASKPASS=/bin/false、GIT\_CONFIG\_NOSYSTEM=1、GIT\_CONFIG\_GLOBAL=/dev/null、GIT\_SSH\_COMMAND=/bin/false；不传 SSH\_AUTH\_SOCK；每次调用带 `-c credential.helper=`。配了 httpProxy 时用 `-c http.proxy=` 显式传入。
- 每个 git 调用都有超时，默认 60 秒。镜像的 pushurl 设为 file:///dev/null。
- 镜像自己的 git 配置只能含插件写入的键，启动时和每次同步时核对。
- 工具：lg\_repo\_sync 拉取并把镜像分支硬重置到远端，返回 head、remoteHead 和两者是否相等；lg\_repo\_log（limit）；lg\_repo\_diff（from、to、可选 path）；lg\_repo\_show（commit、path，逐字节返回）。
- push 探针：在临时仓库里提交一个空树，对 remote 执行 `git push --dry-run <remote> HEAD:refs/heads/<branch>`。成功即 writable，触发暂停。失败信息含 Permission denied、403、denied、read-only、could not read Username、Authentication failed 之一即 denied，通过。其他情况即 inconclusive：只在 lg\_integrity\_check 里显示为警告，不触发暂停。

**lg-integrity**

配置：expectedPreset（默认 lg-global）、profilePrefix（默认 lg-global）、allowedTools（默认为上面的白名单）、localWorkdir（可选，用于自测）。

启动时、每个会话第一次工具调用执行之前、每次 lg\_repo\_sync 时、每次调用 lg\_integrity\_check 时，逐项检查：

1. profile 名以 profilePrefix 开头。
2. preset 注册表的 list() 恰好只有 expectedPreset 一项且没有 broken；不带参数的 inspectCompositions() 与配置一致。
3. 会话实际可调用的工具都在 allowedTools 内。必须枚举 preset 作用域里的工具，不能只看进程级注册表。
4. 会话工作目录在 workspace 之内。
5. 生效配置的哈希与上次记录一致；变化时暂停，由 Human 确认后记录新哈希。
6. 频道里所有 from global 的消息与发件副本逐字节一致。
7. 自测：用 lg-scope 的规则判定“读 localWorkdir（未配置时为 workspace 的上级目录）”和“访问 http://127.0.0.1/”，两者都必须被拒。

启动时的结果由 lg-integrity 直接调用 lg-channel 的内部接口发成 ISOLATION\_REPORT，不经过模型。lg\_integrity\_check 重新跑全部检查，返回总结论、每项结果和警告；全部通过则解除暂停。

**需求**

验证列里的“负面”都必须在真实 Global 会话里由模型发起工具调用，并配一个对照：同样的操作换成允许的目标就能成功。

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| GS-1 | 会话可见工具里没有任何 shell、终端、后台任务或子 agent 工具 | 会话工具列表 |
| GS-2 | lg-global 装进名称不以 lg-global 开头的 profile 时，Global 处于暂停，工具调用被拒 | 负面 |
| GS-3 | 用户 patch 把默认 preset 改回 standard 或重新启用其他 preset 时，Global 暂停 | 负面；不得有端口冲突等无关故障干扰 |
| PS-1 | 进程启动即暂停，lg-integrity 未加载或被关掉时 Global 一直暂停 | 负面：关掉 lg-integrity 后调用 read 被拒 |
| PS-2 | 暂停期间只有 lg\_integrity\_check 可用；复核通过后解除 | 负面与对照 |
| RL-1 | Global 的指令只来自角色文件 | 金丝雀：在 \~/.agents/AGENTS.md、workspace、drafts/ 的子目录里放带标记的 AGENTS.md、AGENTS.local.md、CLAUDE.md，read 该目录下的文件后会话里不出现标记；对照是角色文件的内容出现 |
| RL-2 | 角色文件读不到时暂停 | 负面 |
| SC-1 | 读 Local 的工作目录被拒 | 负面 |
| SC-2 | 用 ../ 和符号链接逃逸被拒 | 负面 |
| SC-3 | 会话工作目录在 workspace 外时，相对路径的 read 和不带 path 的 glob、grep 被拒 | 负面 |
| SC-4 | write 和 edit 只能写 writeRoots | 负面 |
| SC-5 | web\_fetch 访问 127.0.0.1、局域网地址、file:// 和名单外域名都被拒 | 负面 |
| SC-6 | 把一个解析到 127.0.0.1 的域名加进名单后，web\_fetch 仍被拒 | 负面 |
| SC-7 | 另装一个测试插件，其 pre-execute 监听器 prepend 后直接返回 allow，web\_fetch 访问 127.0.0.1 仍被拒 | 负面 |
| SC-8 | pre-execute 之后改写 url 的调用被拒 | 单元测试 |
| RP-1 | lg\_repo\_sync、lg\_repo\_log、lg\_repo\_diff、lg\_repo\_show 对真实仓库工作；同步后镜像 HEAD 等于远端 HEAD | 正面 |
| RP-2 | 手工改动镜像后再同步，改动被撤销 | 正面 |
| RP-3 | 非 https 的 remote、带用户名或令牌的 remote 被拒绝 | 单元测试 |
| RP-4 | git 的环境不含 HOME、SSH\_AUTH\_SOCK 和用户的 git 配置 | 单元测试 |
| RP-5 | 镜像配置被加入未知的键（如 http.extraHeader）时暂停 | 负面 |
| RP-6 | push 探针在本机实测得到 denied；用一个可写的测试仓库做对照，得到 writable 并暂停 | 负面与对照；inconclusive 不算通过 |
| IN-1 | 会话里出现白名单外的工具时暂停，且发生在该会话第一次工具调用执行之前 | 负面 |
| IN-2 | 启动时发出 ISOLATION\_REPORT，内容与 lg\_integrity\_check 一致 | 频道记录 |
| IN-3 | 篡改一条已存档的 global 消息后暂停 | 负面 |

## Global 的写出口与检查点（dsh-lg-global 的 M4 部分）

lg-directive 是 Global 沙箱里 Global 写频道的专用工具集，带比 lg\_post 更严的检查；lg-checkpoint 保护全局视角。形态 A 的网页版 Global 不装插件，但必须遵守同样的消息规则，见“本项目的协作方式”。

**Global 写频道的凭据**

- 形态 B：一个只对频道仓库有 Contents 写权限的 GitHub fine-grained token，存在 Global 的 DSH\_HOME 里，只供 Global 侧的 lg-channel 使用。
- 形态 C：仓库沙箱发给 Global 的令牌，只能写 global 的消息。
- 不论哪种形态，Global 的凭据都不得能写代码仓库；lg-repo 的 push 探针必须证明这一点。

**lg-directive 的工具**

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| lg\_directive | goal、priorities、acceptance、scope、body | 发 DIRECTIVE；版本号自动取当前加 1；字段不全就拒绝；每条验收标准必须引用本规格的需求编号 |
| lg\_review | refs、verdict、findings、body | 发 REVIEW；finding 从 F-1 起编 |
| lg\_decision | answers、choice、reason、approve\_action | 发 DECISION；answers 必须指向未关闭的问题 |
| lg\_draft\_reset | base | 把 drafts/ 重置为镜像里的指定 commit |
| lg\_patch\_send | message | 在 drafts/ 提交改动，生成 git format-patch，先发 CLAIM，再发带附件的 PATCH，bytes 与 sha256 由工具计算 |
| lg\_stop | final\_commit、acceptance | 先执行一次 lg\_repo\_sync；final\_commit 必须等于镜像 HEAD；每条验收标准都要有 environment 为 real 且未过期的证据，否则拒绝发送 |

**lg-checkpoint**

配置 everyMinutes（默认 120）。

- 到点时，以及收到声明里程碑完成的 REPORT 时，向 Global 会话投递“全局检查点”。Global 用一条 REVIEW 回答三个问题：是否在真实目标环境里验证用户真正看到的东西；当前工作是否在关键路径上；范围是否超出 TASK 的约束。
- 监听 agent/turn-stopping：还有未关闭的 QUESTION、OBJECTION 或待审的检查点时，steer 一条提示，要求先处理再结束。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| GD-1 | lg\_directive 拒绝缺字段、增量式或验收标准不引用需求编号的 DIRECTIVE | 负测与正测 |
| GD-2 | lg\_patch\_send 生成的补丁能被 lg\_apply\_patch 应用为 APPLIED；CLAIM 在 PATCH 之前 | 端到端 |
| GD-3 | lg\_stop 在 final\_commit 与远端不符、只有 simulated 证据或证据过期时拒绝；全部满足时发出 | 三个负测一个正测 |
| GD-4 | Global 写频道的凭据写不了代码仓库 | push 探针在配了该凭据的情况下仍得到 denied |
| GK-1 | 全局检查点按配置和里程碑触发，并得到一条回答三个问题的 REVIEW | 会话记录与频道记录 |
| GK-2 | 有未处理的问题或检查点时，Global 的回合不会静默结束 | 负测 |

## Local 侧插件（dsh-lg-local）

Local 侧插件把“证据要原始、先批后做、不碰另外两个区”从提示词变成代码。它们装在 Local 的日常 profile 里，不关掉任何已有能力。

**动作分级**

| 级别 | 规则 | 例子 |
| --- | --- | --- |
| A 自由 | 直接做，REPORT 时提及 | 读代码、跑测试、写证据、普通提交 |
| B 事后报 | 做完立即 REPORT | 改依赖、改配置、启停本地服务 |
| C 先批后做 | 频道里有批准它的 DECISION 才能执行，每次批准只用一次 | 删除数据、改版本号、npm 发布、对外发消息、force push、改写 git 历史、改凭据 |

频道仓库不属于 C 类，而是一律不得改写：不 amend、不 rebase、不 force push、不删消息文件。

**lg-evidence**

配置：digestCommand（默认 `git rev-parse HEAD`）、secretPatterns（默认见下）。

- lg\_evidence\_add：参数 topic、claim、environment（real 或 simulated）、target\_environment、command、raw 文件列表、negative\_tests、controls、result。工具自动填入当前 commit 和 digest，确认 raw 文件存在，写出清单。
- environment 为 real 时，至少一份原始文件必须由工具亲自执行 command 产生。工具记录命令、退出码、起止时间、主机名、dsh 版本和输出的 sha256。
- lg\_evidence\_session：参数是会话 id 和事件序号范围。从 dsh 的会话日志里原样导出这些事件，不改一个字节，并记录 sha256。“模型发起了某次工具调用”这类证据必须用它产生。
- lg\_evidence\_check：扫描所有清单，digest 与当前不符的标为 stale。
- 发布前密钥扫描：形态 A、B 下，raw 文件中出现以下任一内容，工具就拒绝写清单，直到打码：`token=` 后跟 10 位以上字符、`Authorization:`、ghp\_、github\_pat\_、sk-、私钥文件头、配置里列出的公网域名。
- 存放：形态 A、B 放代码仓库的 evidence/\<topic>/；形态 C 上传到仓库沙箱的证据库，清单里只记哈希。

**lg-patch-apply**

lg\_apply\_patch 的参数是 PATCH 消息的序号。工具取回附件并校验 bytes 与 sha256；若 `git apply --check --reverse` 通过则返回 DUPLICATE；确认 base 是 HEAD 的祖先后 `git am`；冲突则回滚并返回 CONFLICT；成功返回 APPLIED 和新 commit。git 以固定参数调用，不经过 shell。

**lg-report-gate**

监听 agent/turn-stopping。回合要结束时，只要以下任一项成立，就 steer 一条提示要求先发 REPORT：当前 HEAD 还没在任何 REPORT 里报过；最新 DIRECTIVE 的版本还没被 REPORT 确认；本回合新增的证据没有清单；有未解决的 blocking finding 却声称完成。

**lg-action-gate**

配置 rules：\[{id, tool, match}\]，match 是正则。默认规则至少覆盖 force push、rm -rf、npm 或 pnpm publish、git commit --amend 与 git rebase（作用于已推送的分支）、修改 git 凭据。

1. 命令命中规则时，同步守卫拒绝，理由里带动作指纹，并提示先请求批准。
2. Local 发 QUESTION，action 写这个指纹。
3. Global 发 DECISION，approve\_action 写同一个指纹。
4. 守卫看到匹配且未用过的批准后放行一次，并在下一条 REPORT 的 consumed\_approvals 里登记该 DECISION 的序号。

**lg-protect**

配置 protectedPaths：Global 的 DSH\_HOME 与 workspace、仓库沙箱的存储目录与 DSH\_HOME。守卫按工具自己的方式解析 read、write、edit、glob、grep 的路径，并检查 bash 命令文本；指向受保护路径就拒绝。bash 的文本匹配只防误操作和模型自发越界，不防刻意绕过，文档里要如实写明。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| EV-1 | lg\_evidence\_add 写出绑定当前 commit 与 digest 的清单；raw 文件不存在时拒绝 | 正测与负测 |
| EV-2 | real 证据至少含一份由工具亲自执行产生的原始输出 | 负测：只有模型提供的文件时不能标 real |
| EV-3 | lg\_evidence\_session 导出的事件与会话日志里的原文逐字节一致 | sha256 对比 |
| EV-4 | digest 变化后清单被标 stale，REPORT 引用它时被 lg\_post 拒绝 | 负测 |
| EV-5 | 形态 A、B 下含 token 或密钥的 raw 文件不能写进清单 | 负测；对照是打码后成功 |
| PA-1 | 正确的补丁返回 APPLIED；哈希不符返回 REJECTED；已存在返回 DUPLICATE；冲突返回 CONFLICT 且工作区已回滚 | 四个用例 |
| RG-1 | 有新 commit 未报时回合被 steer 继续；已报时正常结束 | 正测与负测 |
| AG-1 | 没有批准时 force push 被拒；有批准时执行一次；同一批准第二次使用被拒 | 三个用例 |
| AG-2 | 守卫不现场读频道，用 lg-channel 在内存里维护的批准表 | 代码审查 |
| PT-1 | Local 的 read 或 bash 指向受保护路径时被拒；读写项目文件正常 | 负测与对照 |

## 仓库沙箱（dsh-lg-reposandbox）

仓库沙箱是本机的迷你 GitHub：一个只监听 127.0.0.1 的 git HTTP 服务，放代码仓库、频道仓库和证据库。只追加、发送者核对等规则由服务器执行，不靠双方自觉。它只用于形态 C。

**运行方式**

- 插件 lg-repo-server 装在自己的 profile 里，profile 名以 lg-reposandbox 开头，使用独立的 DSH\_HOME。它不跑在 Local 或 Global 的进程里。
- HTTP 层用 Node 实现，转给 `git http-backend` 处理 git 协议。认证在 HTTP 层做，角色经 REMOTE\_USER 传给 pre-receive 钩子，推送规则在钩子里执行。
- 令牌分 local、global、human 三种，首次启动时随机生成（32 字节），写入 `<storageDir>/tokens/<角色>`，权限 0600。推送时用 HTTP Basic 认证，用户名是角色名，密码是令牌。

**配置**

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| port | 3090 | 监听端口；地址固定为 127.0.0.1，不提供修改地址的配置 |
| storageDir | $DSH\_HOME/reposandbox | 仓库、令牌、证据和日志的存放位置 |
| repos | 必填 | \[{name, kind}\]，kind 取 code 或 channel |
| evidenceMaxBytes | 52428800 | 单个证据文件上限 |

**地址**

- 仓库：`http://127.0.0.1:<port>/<name>.git`。
- 证据：`PUT http://127.0.0.1:<port>/evidence/` 上传，返回内容的 sha256；`GET http://127.0.0.1:<port>/evidence/<sha256>` 读取。

**服务器规则**

| 对象 | 读 | 写 |
| --- | --- | --- |
| 代码仓库 | 匿名可读 | 只接受 local 令牌；拒绝非快进推送和删除分支、标签 |
| 频道仓库 | 匿名可读 | 每个提交只能新增一条消息及其附件，序号必须是下一个；文件名和首行里的发送者必须等于令牌的角色；任何令牌都可以写 HALT，TASK 只接受 human 令牌；status/<角色>.json 只能由对应角色覆盖；不得修改或删除已有文件，不得非快进推送 |
| 证据库 | 匿名可读 | 只接受 local 令牌；按内容哈希存放，不覆盖、不删除 |

服务器对每次写入记一行日志：时间、角色、对象、结果、拒绝原因。

**形态 C 的接线**

- Local：代码推到 `http://127.0.0.1:<port>/<项目>.git`；lg-channel 的 repo 是频道仓库地址，用 local 令牌；lg-evidence 把证据上传到证据库。
- Global：lg-repo 的 remote 是代码仓库地址，匿名读；lg-channel 用 global 令牌；证据按哈希经 lg-repo 读取。
- Local 侧 lg-protect 的 protectedPaths 必须包含 storageDir。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| RS-1 | 只监听 127.0.0.1；从其他地址连不上 | 端口列表与连接尝试 |
| RS-2 | 匿名可以克隆和拉取；匿名推送被拒，Global 的 push 探针得到 denied | 正面与负面 |
| RS-3 | 代码仓库只接受 local 令牌；非快进推送和删除分支被拒 | 三个负面一个正面 |
| RS-4 | 频道仓库拒绝：发送者与令牌不符、序号不连续、修改或删除已有文件、非 human 令牌写 TASK；接受合规的新消息和任意令牌的 HALT | 每条一个负面，另有对照 |
| RS-5 | 证据库按哈希存取，哈希由服务器计算；非 local 令牌上传被拒；同一哈希不能被覆盖 | 正面与负面 |
| RS-6 | 每次写入都有日志 | 日志文件 |
| RS-7 | 形态 C 端到端：Local 发 REPORT、Global 同步并发 REVIEW、Local 应用一个 PATCH，全程所有 git 远端都是 127.0.0.1 | 两侧会话事件、各仓库的 git remote -v、服务器日志 |

## 新模式与同屏（dsh-lg-local 的 M6 部分）

dsh 的模式选择器里新增“共察模式”（英文 Co-Observer，preset id 为 lg-local），与标准模式、极简模式、创造模式并列。选中它的会话成为 Local，并自动配上一个 Global，两者在同一个界面里并排显示。

**先行探针**

开工前必须在 0.2.1-rc.2 里查清三件事，并把源文件路径和行号作为证据提交：

1. 插件能否在 Web 界面里加一个面板或标签页。
2. 插件能否用 ctx.subprocess 启动并看管一个长期运行的 dsh 进程。
3. 怎样在 Local 的界面里安全地显示 Global 进程的会话。

**preset lg-local**

- 由 dsh-lg-local 的 cordis.patch.yml 声明，显示名“共察模式”，排在内置模式之后。
- 工具组合等于标准模式，再加上本项目的 lg\_\* 工具，不关掉任何东西。内置模式照常可用。
- 会改变会话流程的行为，即频道投递和 lg-report-gate，只作用于共察模式的会话或用 /lg-bind 绑定的会话。lg-protect 和 lg-action-gate 是安全守卫，对同一 profile 里的所有会话生效。
- 选中共察模式的新会话自动成为绑定会话。已有绑定会话时不自动抢绑定，界面提示用 /lg-bind 切换。

**lg-pairing**

配置：form（A、B 或 C）、globalProfile（默认 lg-global）、globalDshHome、globalWorkspace、globalPort（默认 3081）、repoSandboxProfile、repoSandboxDshHome、repoSandboxPort（默认 3090）。

- 形态 B、C：会话进入共察模式时，先探测 Global 进程是否在 globalPort 上运行。不在就用 ctx.subprocess 启动 `dsh --profile <globalProfile> --port <globalPort>`，环境变量 DSH\_HOME 为 globalDshHome，工作目录为 globalWorkspace。
- 自己启动的 Global 进程崩溃时自动重启，最多 3 次，间隔逐次加倍；Local 的 dsh 退出时一并停止。原本就在运行的 Global 进程不受影响。
- 形态 C：用同样的方式确保仓库沙箱在运行。
- 形态 A：不启动进程，只显示频道。

**界面**

- 左侧是 Local 的对话，与平时一样。
- 右侧面板有两个标签页。“Global”显示配对 Global 的会话，Human 可以在里面直接和 Global 对话；“频道”显示消息时间线、待审检查点、未关闭问题和等 Human 处理的事。
- 面板只给 Human 看。Global 界面的访问 token 只保存在 lg-pairing 的内存里并交给浏览器，不得写进 Local 的会话、日志，或 Local 工具能读到的任何文件。
- 探针 1 证明插件不能加面板时，改为在 Local 界面顶部放“打开 Global”链接，在新标签页打开 Global 的界面；频道时间线由 /lg-status 提供。探针 2 证明不能看管进程时，改为只探测和提示，启动命令写进文档。采用哪种退路，必须在 REPORT 里附探针证据说明。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| MD-1 | 模式选择器里出现“共察模式”，内置模式仍可用 | 界面截图 |
| MD-2 | 共察模式会话的工具是标准模式全部工具加 lg\_\* 工具 | 两种模式的工具列表对比 |
| MD-3 | 同一 profile 里的非共察会话不受频道投递和 lg-report-gate 影响 | 对照会话的记录 |
| MD-4 | 形态 B、C 下进入共察模式后，Global 进程运行且完整性检查通过 | 会话事件与 lg\_integrity\_check 输出 |
| MD-5 | 形态 C 下仓库沙箱同时在运行 | 服务器日志 |
| MD-6 | Human 能在右侧面板（或退路链接）看到 Global 的会话并与它对话，能看到频道时间线 | 界面截图 |
| MD-7 | Local 的会话事件、日志和它的工具能读到的文件里都找不到 Global 的访问 token | 全量搜索的命令与输出 |
| MD-8 | 卸载 dsh-lg-local 后共察模式消失，--dump-config 与安装前一致 | 三份 dump-config |

## 测试与证据要求

一条需求算完成，必须同时有通过的测试和可独立核对的原始证据。自述、总结和截断的输出都不算。

**测试层级**

| 层级 | 做法 | 用于 |
| --- | --- | --- |
| 单元测试 | vitest，在仓库根目录 `pnpm -r test` | 协议、解析、判定逻辑 |
| 集成测试 | 真实 git 仓库、真实文件系统 | 频道并发、镜像同步、补丁应用、仓库沙箱规则 |
| 探针 | 测试插件在真实 dsh 里直接调用接口 | 确认 dsh 接口的形状；不能作为验收证据 |
| 会话验收 | 真实 dsh 0.2.1-rc.2 里的真实会话，模型自己发起工具调用，用 lg\_evidence\_session 导出原始事件 | 所有标为“负面”“正面”“端到端”的验证 |

**证据规则**

- 每个里程碑一个索引 evidence/<里程碑>/README.md（形态 C 为证据库里的同名清单）。索引按需求编号逐行列出：证据文件、执行的命令、环境（real 或 simulated）、结果和对应 commit。
- 负面证据必须显示目标规则自己的报错原文，并配一个对照。由无关故障造成的失败（如端口冲突）不算。
- “拦住了”必须体现为一次真实工具调用被拒；只有一条 FAIL 记录不算。
- 每用到一个 dsh 接口，都在 evidence/<里程碑>/dsh-interfaces.md 里写明源文件路径和行号。
- 提交证据前必须扫描密钥和访问 token，扫描命令与结果一并提交。.gitignore 不得吞掉证据文件。
- 代码在证据产生后变了，受影响的证据必须重新跑。

**需求**

| 编号 | 要求 | 验证 |
| --- | --- | --- |
| QA-1 | pnpm install 无错误无警告，pnpm -r build 和 pnpm -r test 全部通过 | 完整输出存为 evidence/<里程碑>/test.txt |
| QA-2 | 本里程碑范围内的每个需求编号在索引里都有一行 | Global 逐行核对 |
| QA-3 | 每项负面证据都有目标规则的报错原文和对照 | Global 打开原件核对 |
| QA-4 | 会话验收类证据都是 lg\_evidence\_session 导出的原始事件，能看到模型发起的调用和返回 | sha256 与会话日志一致 |
| QA-5 | 证据绑定的 commit 是验收时的 HEAD，或与 HEAD 之间没有影响该需求的改动 | git diff |
| QA-6 | 已提交的证据里没有密钥、访问 token 或公网部署地址 | 扫描输出 |
| QA-7 | 所用 dsh 接口都有源码引用 | dsh-interfaces.md |

## 里程碑与验收标准

里程碑按顺序做，前一个验收后才开始下一个。一个里程碑验收的条件是：表中列出的需求都有证据，QA-1 到 QA-7 对本里程碑成立，并且没有未解决的 blocking finding。

| 里程碑 | 内容 | 必须满足的需求 | 状态 |
| --- | --- | --- | --- |
| M1 频道与协议 | lg-protocol、lg-channel、lg-commands | PR-1 至 PR-5、PR-7、PR-8、PR-10；CH-1 至 CH-3、CH-5 至 CH-8、CH-11；CM-1 | 已验收 |
| M2 Global 沙箱 | preset lg-global、lg-role、lg-scope、lg-repo、lg-integrity、暂停状态、发件副本比对 | GS-1 至 GS-3；PS-1、PS-2；RL-1、RL-2；SC-1 至 SC-8；RP-1 至 RP-6；IN-1 至 IN-3；CH-12 | 进行中 |
| M3 协议补充与 Local 侧 | id、supersedes、checkpoint、meanwhile；投递去重与 Global 唤醒；lg-evidence、lg-patch-apply、lg-report-gate、lg-action-gate、lg-protect | PR-6、PR-9、PR-11；CH-4、CH-9、CH-10；EV-1 至 EV-5；PA-1；RG-1；AG-1、AG-2；PT-1 | 未开始 |
| M4 Global 写出口与检查点 | lg-directive、lg-checkpoint、Global 写频道的凭据 | GD-1 至 GD-4；GK-1、GK-2 | 未开始 |
| M5 仓库沙箱 | dsh-lg-reposandbox；两侧插件接入仓库沙箱地址 | RS-1 至 RS-7 | 未开始 |
| M6 新模式与同屏 | 先行探针；preset lg-local、lg-pairing、右侧面板 | MD-1 至 MD-8 | 未开始 |
| M7 最终验收 | 三种形态端到端、OnCue 回放、文档与安装 | “最终验收”一节的 FA-1 至 FA-8 | 未开始 |

**每个里程碑的做法**

1. Global 发一条 DIRECTIVE，验收标准逐条引用上表的需求编号，可以拆成若干项 P。
2. Local 遇到接口与本规格不符，先做探针，再发 QUESTION，不自行绕过。
3. 每完成一项 P，Local 发带 checkpoint 的 REPORT；Global 审核并回一条 REVIEW。
4. 全部需求有证据后，Local 发里程碑完成的检查点 REPORT；Global 逐条核对索引，以 verdict 为 accepted 的 REVIEW 宣布验收。
5. M7 通过后，Global 发 STOP。

## 本项目的协作方式

本项目的两个模型通过 Human 部署的 webchat 自动通信，不再由 Human 转贴。Global 用 lgchat.py 在 webchat 里收发；Local 不直接碰 webchat，仍然只用频道仓库。两边之间由桥接程序 lgbridge.py 自动同步，GitHub 上的频道仓库始终是正式存档。

**组件与地址**

| 组件 | 谁用 | 作用 |
| --- | --- | --- |
| webchat.py | Human 部署在自己的服务器上，公网可访问 | 消息中转；ai1 的 token 给 Global，ai2 的 token 给桥，viewer 的 token 给 Human 旁观 |
| lgchat.py | Global | 发消息（send）、等待唤醒（wait）、翻看历史（read）；自动保存游标和发出副本 |
| lgbridge.py | Human 在 Local 的机器上常驻运行 | 把 Global 的消息原样存进频道仓库；把频道仓库里 Local 和 Human 的新消息转发到 webchat |
| 频道仓库 | 三方 | `https://github.com/codezzzsleep/local-global-channel`，公开，正式存档 |
| 插件仓库 | 三方 | `https://github.com/codezzzsleep/dsh-local-global`，公开，MIT，默认分支 main |

Global 的运行环境必须能执行命令，并能访问 webchat 和 GitHub。

**部署要求（Human 负责）**

- webchat 应当通过 https 访问，例如在前面放一个自动签发证书的反向代理，代理保留原始 Host 头。明文 http 会让 token 在公网上暴露。
- webchat 不与 Local 在同一个系统用户下运行，Local 的工具不得能读写它的数据目录。
- 桥用一份专门的频道仓库克隆，不与 Local 的 lg-channel 共用。
- token 只交给对应的一方，不得写进频道、仓库、证据或 webchat 消息。

**消息格式**

- webchat 里每条消息的正文就是一条完整的频道消息：首行 `[LG <类型> from <发送者>]`、YAML 字段区、`---`、正文，规则见“消息协议”。一条 webchat 消息只放一条频道消息。
- 每条消息带 id：Global 从 G-0001、Local 从 L-0001 起递增。lgchat.py 把 id 用作 client\_id，重发不会产生重复消息。
- Global 的单条消息不超过 16000 个字符，更长的内容放进插件仓库。Local 的消息超过这个长度时，桥只转发首行和字段区，正文指向频道仓库里的原文。

**一轮是怎么转起来的**

1. Local 到达检查点，用 lg\_post 把带 checkpoint 的 REPORT 写进频道仓库。桥自动把它转发到 webchat。
2. Global 平时停在 `lgchat.py wait` 上。它只在唤醒类消息到来时返回：带 checkpoint 的 REPORT、阻塞的 QUESTION、OBJECTION、TASK、HALT，并把期间的其他消息一并列出。超时（退出码 2）就再运行一次。
3. Global 按检查点的 commit 阅读插件仓库的代码和证据原件，把本轮消息写成文件，用 `lgchat.py send` 发出，优先合成一条。
4. 桥把 Global 的消息原样存进频道仓库，Local 的 lg-channel 照常投递给绑定的会话。这些消息已经存过档，Local 不再用 lg\_record\_relayed 存一次。
5. Global 下一轮开始时，把 lgchat-state/sent/ 里的发出副本与频道仓库里的存档逐字节核对；不一致或缺失就告诉 Human。

**Global 必须做到**

- 每条消息带 id，用 lgchat.py 发送。
- 发出即为最终版，不撤回、不作废；要改就发 CORRECTION，或发带 supersedes 的新消息。
- 发出前对照“消息协议”自查格式：首行、YAML、必填字段、AC 与 F 的编号格式。
- REVIEW 的 finding 和 DIRECTIVE 的验收标准都引用本规格的需求编号。
- 定方向、定约束、定验收，不替 Local 写实现；但涉及集成的名字和格式必须写准。
- 不只信 REPORT：结论必须来自仓库里的代码和证据原件，每轮至少打开一份原始证据。
- 只在唤醒类消息到来时开始一轮，不逐条回应进度消息。

**Local 必须做到**（写进插件仓库的 AGENTS.md）

- 完成 DIRECTIVE 的一项 P 时发带 checkpoint 的 REPORT；之后只做 meanwhile 里声明过的、与被审内容无关的工作，没有声明就等待。
- 需要 Global 决定时发 QUESTION，写明默认动作，继续做不受阻的部分；不同意时发 OBJECTION 并附证据。
- 连续工作 30 分钟没发过消息时，发一条进度 REPORT；停下之前，有未报告的提交就先发 REPORT。
- 频道投递来的 Global 消息已由桥存档，不再存一次；只有 Human 粘贴进会话的消息才用 lg\_record\_relayed。
- 不改写频道仓库，不 force push；提交只用本机 git 身份，不加其他作者或尾注。
- commit 字段用 `git rev-parse HEAD` 取，不手工补全。
- 频道和证据里不出现访问 token、密钥和公网部署地址。

**Human 的位置**

- 运行 webchat 和桥，用 viewer token 旁观。
- webchat 应当增加一个 human 写入角色。在增加之前，Human 在 Local 的界面执行 /lg-halt，HALT 会写进频道仓库并由桥转给 Global；紧急时直接停掉两个模型的进程。
- 部署与权限只由 Human 决定。C 类动作由 Global 用 DECISION 批准；npm 发布另外还需要 Human 同意。

## 当前状态与交接

截至本规格发布，M1 已验收，M2 的实现基本写完但还没验收。新的 Global 从这里接手。

**频道**

- 已有消息 0001 到 0039，当前指令是 0025 的 DIRECTIVE v3（M2）。最新一条是 0039，即 Local 的 REPORT，对应插件仓库 commit 17ecb5a。
- 未关闭的问题：0037，匿名 https 的 push 探针在 Local 机器上挂住后超时。本规格的答复见 lg-repo 与 RP-6：先用 lg-repo 自己的 git 环境分别跑 ls-remote 和 push --dry-run；如果 ls-remote 也挂住，原因就是精简环境丢掉了代理设置，用 httpProxy 解决。inconclusive 只警告不暂停，但验收必须在本机实测得到 denied。
- v2 之前的 Global 消息都没有 id，新的 Global 从 G-0001 开始编号。

**插件仓库（commit 17ecb5a）**

- 已有：lg-protocol 与 dsh-lg-common（M1）；dsh-lg-global 的 preset、lg-role、lg-scope、lg-repo、lg-integrity，暂停状态已经是启动即暂停；98 个测试通过。
- 已知与本规格不符、需要先核对的地方：inconclusive 目前会触发暂停；没有 httpProxy；remote 还不接受仓库沙箱地址（M5 再加）；CH-12 与 IN-3 是否已实现尚未核实。
- 还没做：用真实会话重做 M2 的负面与对照，尤其是 SC-3、SC-6、SC-7、GS-3（不得再有端口冲突干扰）、RL-1 的金丝雀。
- docs/design.md 与 docs/implementation.md 早于本规格。

**新 Global 的前三步**

1. 读完本规格，再读频道 0025 到 0039 和插件仓库 17ecb5a。
2. 发一条 DECISION 关闭 0037，内容以本规格为准。
3. 发 DIRECTIVE v4，收尾 M2：第一项是把 Human 交给 Local 的本规格存为 docs/spec.md，并在旧文档里标明以它为准；其余各项的验收标准逐条引用 M2 的需求编号。

## 最终验收

全部里程碑完成后，由独立检查者按本节逐条核对。检查者没有参与开发，只看公开仓库里的代码、证据和频道记录，并会在干净的克隆里重跑测试。

**Local 要交出的东西**

- 插件仓库上的 git 标签 v0.1.0（不发布到 npm，除非 Human 另行批准）。
- README：形态 A、B、C 各自的安装、配置和启动步骤。
- evidence/FINAL/README.md：本规格的每个需求编号一行，指向证据和结果。

**验收条目**

| 编号 | 要求 | 检查者怎么验 |
| --- | --- | --- |
| FA-1 | 按 README 在干净的 DSH\_HOME 里装上全部 bundle 并跑起来；卸载后 --dump-config 与安装前一致 | 看安装记录与三份 dump-config |
| FA-2 | 本规格全部需求编号都有证据；验收类条目是 real 环境的会话证据 | 逐行核对 FINAL 索引，抽查原件的 sha256 |
| FA-3 | 形态 B 端到端：TASK、DIRECTIVE、带 checkpoint 的 REPORT、REVIEW、PATCH 应用、STOP 全部由模型经插件完成 | 两侧导出的会话事件与频道记录 |
| FA-4 | 形态 C 端到端：同一流程，全程所有 git 远端都是 127.0.0.1 | 会话事件、git remote -v、仓库沙箱日志 |
| FA-5 | 形态 A：同一条 Global 消息粘贴两次只存档一次；被替代的消息不执行 | 频道记录与 Local 会话事件 |
| FA-6 | OnCue 三个回放用例都被 Global 在没有 Local 提示的情况下发现：证据绑定旧 digest 被标 stale；只有 simulated 证据时 lg\_stop 被拒；缺负测的“通过”被退回 | 频道里的 REVIEW 与工具拒绝记录 |
| FA-7 | 绕过尝试全部失败：相对路径、符号链接、prepend 监听器、界面切换 preset、加工具、AGENTS.md 金丝雀、凭据经环境变量或 .netrc 泄露 | 逐项看被拒的会话事件和暂停原因 |
| FA-8 | README、docs/spec.md、docs/channel-git.md 与代码一致；每个配置字段都有文档；仓库里没有有效的密钥或 token | 代码与文档对照、扫描输出 |

## 已定决策与必须实测的接口

下面这些之前悬而未决的问题，在本规格里已经定下。要改只能由 Human 决定。

| 问题 | 决定 |
| --- | --- |
| 新模式的名字 | 共察模式（Co-Observer），preset id 为 lg-local |
| 检查点之后 Local 做什么 | 只做 meanwhile 里声明过的、与被审内容无关的工作；没有声明就等待 |
| 检查点的粒度 | DIRECTIVE 的每一项 P、阻塞的 QUESTION、里程碑完成 |
| 形态 A 下 Global 怎么写频道 | 首选只能写频道仓库的凭据；没有就走中转。本项目用 webchat 传递，由桥接程序自动存档到频道仓库 |
| 仓库沙箱跑在哪里 | 自己的 profile（lg-reposandbox 前缀）和独立 DSH\_HOME |
| push 探针查不出结果时 | 只警告不暂停；验收必须在本机实测得到 denied |
| 一个 Global 对多个 Local | v0.1 不做 |
| 用本地模型权重做 Global | v0.1 不做专门支持 |
| 补丁大小上限 | 不设硬上限；PATCH 只用于一眼能审完的小改动，大块实现交给 Local |

**开工前必须实测的接口**

- M2 收尾前：0037 的挂起原因（见“当前状态与交接”）。
- M5 开工前：git http-backend 在本机可用，并且 REMOTE\_USER 能传到 pre-receive 钩子。
- M6 开工前：“新模式与同屏”一节的三个先行探针。

探针结果和本规格不符时，Local 发 QUESTION，Global 在本规格定下的退路里选择；本规格没有退路的，由 Human 决定。
