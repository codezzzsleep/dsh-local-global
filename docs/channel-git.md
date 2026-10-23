# Git 频道契约 v0.1

本文是 lg-channel 默认后端的完整契约：频道就是一个 git 仓库，不需要单独的服务。设计文档“频道协议”一节规定消息的类型与语义，本文规定它们在 git 仓库里的落地方式。

## 1. 仓库布局

```text
<频道仓库>/
├── messages/        只追加的消息，每条一个文件
├── attachments/     消息附件：attachments/<序号>/<文件名>
└── status/          每个角色一个状态文件，原地覆盖：status/local.json、status/global.json
```

- 默认分支 `main`。
- `messages/` 和 `attachments/` 下的文件一经提交，不得修改或删除；更正用 CORRECTION 消息。
- `status/` 是唯一允许原地覆盖的目录。
- 附件由 `lg_post` 的 `attachments` 参数 `[{name, content}]` 写入 `attachments/<序号>/<name>`，与消息在同一个提交里；`name` 经过净化，路径分隔符、`..`、点开头的名字一律拒绝。

## 2. 文件名

`messages/<序号>-<发送者>-<类型>.md`

- 序号：四位十进制，从 `0001` 起连续递增，不跳号。
- 发送者：`human`、`global`、`local` 之一。
- 类型：设计文档“消息类型”表中的类型，全大写。
- 文件名里的发送者和类型必须与首行一致，否则这条消息非法。
- 一个提交只包含一条消息及其附件，提交信息为 `msg <序号> <发送者> <类型>`。

## 3. 消息格式

```text
[LG <类型> from <发送者>]
<YAML 字段区>
---
<正文，可选，Markdown>
```

- 首行必须匹配正则 `^\[LG ([A-Z_]+) from (human|global|local)\]$`。
- 字段区从第二行开始，到第一行内容恰好为 `---` 的行或文件结束为止，内容是一个 YAML 映射。
- 所有类型都可以带 `refs`：被引用消息的序号列表，元素为四位字符串，例如 `['0002']`。
- 编码 UTF-8，换行 LF，文件以换行结尾。
- 解析再渲染必须逐字节一致（PR-3）：字段区按原文保留，正文原样保留（包括末尾空行）。`formatMessage` 写新消息时正文原样写出，只在缺少末尾换行时补一个。

## 4. 各类型的发送者与必填字段

**所有类型**都可以带 `refs`、`id` 和 `supersedes`，下表的"可选字段"只列各类型自己的额外可选项。

| 类型 | 允许的发送者 | 必填字段 | 可选字段 |
| --- | --- | --- | --- |
| TASK | human | `goal`、`constraints`、`budget` | — |
| REPORT | local | `refs`、`commit`、`directive_version`、`evidence`、`negative_tests` | `open_questions`、`consumed_approvals`、`resolves`、`checkpoint`、`meanwhile` |
| QUESTION | local | `options`、`blocking`、`default_action` | `action` |
| DECISION | global | `answers`、`choice`、`reason` | `approve_action` |
| DIRECTIVE | global | `version`、`goal`、`priorities`、`acceptance`、`scope` | — |
| PATCH | global | `name`、`claim`、`base`、`format`、`bytes`、`sha256` | — |
| CLAIM | global、local | `scope`、`implementer` | — |
| OBJECTION | local | `target`、`evidence` | — |
| CORRECTION | global、local、human | `corrects`、`replacement` | — |
| REVIEW | global | `refs`、`verdict`、`findings` | — |
| ISOLATION_REPORT | global、local | `probes` | — |
| STOP | global | `final_commit`、`acceptance` | — |
| HALT | human | `reason` | — |

字段约定：

- `budget`：映射，v0.1 只有 `max_hours`（数字）和 `max_rounds`（整数）两个键。
- `commit`、`base`、`final_commit`：完整 40 位 SHA。
- `evidence`、`negative_tests`：列表，可以为空列表，但字段必须存在。
- QUESTION 的 qid 就是这条 QUESTION 自己的序号，不另设字段。`default_action` 不得是 C 类动作。`action` 是 C 类动作指纹（见第 7 节），需要批准时填写。
- DECISION 的 `answers` 是被回答的 QUESTION 或 OBJECTION 的序号列表，一条 DECISION 可以同时关闭多个。
- DIRECTIVE 的 `version` 从 1 开始，每次加 1；`acceptance` 是列表，每项是 `{id: AC-<n>, text: ...}`；`scope` 是 `{in: [...], out: [...]}`。
- PATCH 的 `format` 固定为 `git-format-patch`；补丁文件放在 `attachments/<序号>/<name>`，与 PATCH 消息在同一个提交里；`bytes` 和 `sha256` 是该文件的字节数和 sha256（`lg_post` 发 PATCH 时核对）；`name` 必须是普通文件名：不含路径分隔符、不以 `.` 开头。
- CLAIM 的 `implementer` 是 `global` 或 `local`。
- CORRECTION 只能更正自己发出的消息：`corrects` 指向他人的消息或不存在的序号时不生效，`lg_post` 直接拒绝。
- REVIEW 的 `verdict` 取 `accepted` 或 `changes-requested`；`findings` 是列表，每项为 `{id: F-<n>, severity: blocking 或 minor, text}`，`verdict` 为 `accepted` 时可以是空列表。
- REPORT 的可选字段 `resolves` 列出已解决的 finding，写法是 `<REVIEW 序号>/F-<n>`，例如 `0011/F-1`。每条 REVIEW 的 finding 都从 F-1 起编，只写 `F-1` 会把别的 REVIEW 的同号 finding 一起算成已解决。正文需逐条说明解决方式。有 blocking 的 finding 未解决时，对应的工作项不算完成。
  - 注意：v2 之前的消息用的是裸 `F-<n>` 形状。频道只追加，那些消息保持原样；本契约只管新消息。
- `id`：v2 新增。形如 `G-0042`、`L-0107`、`H-0003`——发送方前缀加四位以上数字，由发送方在写消息时生成，按发送方各自递增、不重复。新写的消息必须带 `id`；没有 `id` 的旧消息按序号处理，不判为非法。`lg_post` 自动生成：取该发送方已有的最大序号加 1（`L-0001` 起）；调用方自带 `id` 时校验格式与前缀，并要求未被使用、且大于该发送方已有的最大值。同一个 `id` 在频道里出现第二次时，后一条非法。
- `supersedes`：v2 新增。被替代的 `id` 列表，只能替代同一发送方自己**更早**的消息。未知的 `id`、他人的 `id`、自己的 `id`，以及 HALT 的 `id`，都不生效：`lg_post` 直接拒绝，读取方照常投递这条消息并在前面标注“该引用无效”。HALT 永远不能被替代，包括被 human 自己替代。
- REPORT 的 `checkpoint`：v2 新增，布尔。为 `true` 时表示请求 Global 审核 `commit` 字段指向的版本。
- REPORT 的 `meanwhile`：v2 新增，字符串列表，写明等待审核期间要做、且与被审内容无关的工作。`open_questions` 同为字符串列表。
- `probes`：列表，每项是 `{name, expected, actual, pass}`，前三项为字符串（`name` 非空），`pass` 为布尔。
- STOP 的 `acceptance`：列表，每项是 `{id: AC-<n>, evidence: [...]}`，覆盖当前 DIRECTIVE 的全部验收标准。

## 5. STATUS

STATUS 用于心跳和状态，不进 `messages/`，不占序号，以免冲淡消息记录。

- 文件：`status/<角色>.json`，原地覆盖。
- 内容：`{"state": ..., "last_read": "<序号>", "directive_version": <整数>, "updated_at": "<ISO 8601 UTC>"}`。
- `state` 取值：`working`、`idle`、`blocked`、`budget-exhausted`、`halted`。
- 更新时机：`state` 变化时立即更新；否则最多每 10 分钟一次。提交信息为 `status <角色> <state>`。
- 判断对方失联：`updated_at` 超过 20 分钟未更新。

## 6. 写入与并发

写一条消息的步骤：

1. `git fetch`，以远端 `main` 为准
2. 取 `messages/` 下的最大序号加 1
3. 写文件（及附件），单独提交，push
4. push 被拒时：丢弃本地提交，回到第 1 步重新取号。重试有上限（实现默认最多 8 次尝试），每次重试前随机退避（上限从 100 ms 起每次翻倍，封顶 2 秒），避免同时冲突的写入者步调一致地再次冲突；仍失败就返回错误
5. 只有 push 被拒（非快进、引用被锁）才重试；认证失败、网络不通等不重试，直接返回错误。同一进程里对同一镜像的写入按顺序执行

## 7. 读取、游标与派生状态

- 每 `pollSeconds` 秒 fetch 一次，默认 60。fetch 失败（远端不存在、网络不通、认证失败）是错误，不是空频道；只有远端存在而还没有分支才算空频道。第一次绑定要等 fetch 成功才设游标。
- 游标是已投递的最大序号，存在 dsh 的存储里，只在投递成功后前移；游标与已投递的 `id` 在同一次持久化里写入。投递抛错时游标和 `id` 都停在该消息之前，下次轮询重试，不会越过未投递的消息。第一次绑定把游标设为按文件名算出的最大序号（内容不可解析的也算历史）。
- 新消息按序号顺序校验并投递。校验不通过的消息不投递原文，改为投递一条 `[LG INVALID #<序号>] <原因>` 提示；游标照常前移，不被卡住。Global 侧用 inject 放进上下文，不开回合（CH-4）。
- 投递的消息带标签 `[LG #<序号> <类型> from <发送者> id=<id>]`（DIRECTIVE 为 `[LG #<序号> DIRECTIVE v<版本> from <发送者> id=<id>]`；没有 `id` 的旧消息省略 `id=`）。
- 发送者与本侧角色相同的消息不投递，非法的也不投递；本侧自己用中转存档的消息不投递；`human` 的消息投递给两侧。已投递过的 `id` 不再投递。
- **HALT**：按文件名或首行认定 human 的 HALT，不看字段是否合法——字段非法、YAML 无法解析的 HALT 照样停机，问题只在投递文本里标注。任何 `supersedes` 都不能压制 HALT。一次轮询里出现 HALT 时先处理它：取消当前回合、停止本侧、不再投递任何消息（它之前尚未投递的和它之后的都不投）。停机状态持久保存，停机后本侧不再授予任何批准。契约没有规定恢复方式，目前只能由人清除本侧状态文件。
- 被替代的消息以 `[LG #<序号> <类型> SUPERSEDED by <id>]` 投递，并写明“不要执行”；只有同一发送方更早的 `supersedes` 才算数，他人的引用不改变投递方式。

以下状态都由读取方从 `messages/` 折叠计算，不另外存储。折叠只使用通过校验的消息：非法消息、重复 `id` 的后一条、旧版两条（见第 10 节）不参与；`supersedes` 只在同一发送方内生效，被替代的消息不再产生批准、未关闭问题、检查点和 finding（被替代的 REPORT 登记的 `consumed_approvals` 仍然有效，宁可少批准）。频道最大序号仍按全部文件计算。

- **当前 DIRECTIVE**：`version` 最大的那一条。
- **未关闭问题**：没有被任何 DECISION 的 `answers` 引用的 QUESTION 和 OBJECTION。
- **未解决 finding**：全部 REVIEW 的 `findings`，减去全部 REPORT 的 `resolves`（按 `<REVIEW 序号>/F-<n>` 配对，所以不同 REVIEW 的同号 finding 互不影响）。
- **已替代**：被同一发送方更早的有效消息的 `supersedes` 引用的 `id`；HALT 不会出现在这里。
- **待审检查点**：带 `checkpoint: true` 的 REPORT，之后还没有任何 Global 消息在 `refs` 里引用它。
- **可用的批准**：所有 DECISION 的 `approve_action`，减去所有 REPORT 的 `consumed_approvals`。`consumed_approvals` 登记的是**已用掉批准的那条 DECISION 的序号**，不是动作指纹——指纹只用于匹配命令，序号才唯一确定是哪一次批准。lg-action-gate 放行一次后立即在内存里扣除，并在下一条 REPORT 的 `consumed_approvals` 里登记该 DECISION 序号。
- `/lg-status` 与 `lg_open_questions` 列出未关闭问题、未解决 finding（`lg_open_questions` 只列 blocking 的）和待审检查点。
- **动作指纹**：`<规则 id>:<命令文本 UTF-8 编码的 sha256 前 12 位十六进制>`。

## 8. 中转模式

Global 不能直接写频道仓库时（例如 Global 在一个只能读公开仓库的环境里），使用中转模式：

- Global 把消息全文交给 Human，Human 粘贴给 Local。
- Local 用 `lg_record_relayed` 工具原样存档：参数就是全文；首行的发送者必须是 `global` 或 `human`；文件名按首行生成；工具不得改动任何字节。
- 只有 lg-channel 配置了 `relay: true` 时这个工具才注册、才可用。
- 同一个 `id` 已在频道里就不新建文件，返回已有序号，并说明已有文件与粘贴的字节是否一致。
- 存档后立即从频道读回，与粘贴的字节逐字节比对；不一致就报错（消息已不可撤回）。存档的消息不会再被投递回 Local。
- 存档不校验字段：不符合第 4 节要求的中转消息照样原样入库，由读取方标为 `[LG INVALID #<序号>]`。协议升级期间这是必须的——某一侧还不认识的新类型，不能因此存不进去。只检查首行（字段区是不是合法 YAML 也不管），首行无法解析才拒绝，因为文件名要从首行生成。
- Local 必须先存档、再执行。

## 9. 时间与身份

- 消息的时间取提交时间（committer date）。它由写入方的机器设定，不是服务器时间。v0.1 接受这一点，失联判断留出 2 倍余量（见第 5 节）。
- 发送者身份靠首行和文件名声明。两侧可能使用同一个 git 账号，中转模式下必然如此，所以仓库本身不能防伪。
- 防伪由 Global 负责：Global 保存自己发出的每条消息的副本，每次读取频道时，逐个把副本与存档逐字节比对，不一致就发 ISOLATION_REPORT。比对以副本为准，不看存档里能不能解析：存档里缺失（被删、被换名）和首行被破坏的也算不一致。同一个不一致只报一次，且要报告发出成功才算已报（失败下次重试）；已报记录持久保存，重启不重复。
- 凭据：仓库地址里的用户名、密码和令牌，不得出现在 `/lg-status`、错误信息、日志和状态文件里（以 `***` 代替）。

## 10. 兼容说明

本契约生效前的 `0001-human-TASK.md` 和 `0002-local-REPORT.md` 按原样保留，不参与校验。豁免只针对这两条（序号、发送者、类型都对得上）：0001–0002 里的其他消息照常校验；这两条也不参与折叠，不能授予批准。
