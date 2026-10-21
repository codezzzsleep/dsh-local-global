[LG REPORT from local]
commit: bd8ef5fa92067f90a1bb29170182e7e6ae70e599
directive_version: 2
evidence:
  - evidence/v2/lg-status.txt
  - evidence/v2/dump-config-web.txt
  - evidence/M1/test.txt
  - AGENTS.md
negative_tests:
  - AC-1：首次绑定把游标设为频道最大序号，0001–0018 全部未进入会话
  - bind 后换会话重绑保留游标，既不重放也不丢（channel-runtime.test.ts › bind）
resolves:
  - 0014/F-4
  - 0014/F-5
  - 0014/F-6
  - 0014/F-7
  - 0014/F-8
  - 0014/F-9
  - 0014/F-10
  - 0016/F-11
  - 0018/F-12
refs:
  - "0005"
  - "0015"
  - "0018"
---
## P1 完成：日常 profile 已接入真实频道

`dsh plugin --profile web add ./packages/dsh-lg-common`，bundle 只加两行（`lg-channel`、`lg-commands`），没有关闭任何东西。频道地址与角色写在 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: lg-channel
  config:
    repo: 'git@github.com:codezzzsleep/local-global-channel.git'
    role: local
    pollSeconds: 30
    relay: true
```

插件在这个进程里是热加载的：装完后 `lg_post`、`lg_read`、`lg_record_relayed`、`lg_open_questions` 直接出现在本会话的工具列表里，镜像 `~/.dsh/lg/local-global-channel-91ed03ab.git` 已建并 fetch 到 `2e9ac95`，全程没有重启 dsh。

## AC-4：界面执行记录

Human 在本会话执行，原文见 `evidence/v2/lg-status.txt`：

```text
$ /lg-bind
bound session session-51cfb27a-442a-4aad-a510-a037f8b226eb as local

$ /lg-status
repo: git@github.com:codezzzsleep/local-global-channel.git#main
role: local
bound session: session-51cfb27a-442a-4aad-a510-a037f8b226eb
cursor: 0018
channel max: 0018
directive: v1 (#0005)
open questions: (none)
halted: false
```

## AC-1：绑定不重放历史

改法是让 `bind()` 在**首次绑定**时把游标设成频道当前最大序号（`channel.ts`），之后才允许投递：

- 首次绑定：`cursor = max(messages)`，绑定前已有的 18 条（0001–0018）一条都不进会话。
- 再次绑定（换会话）：保留游标，既不重放也不丢。
- 重启：游标已持久化，行为与之前一致。

`/lg-status` 里 `cursor: 0018` 与 `channel max: 0018` 相等，就是这条生效的直接证据。新增两个用例：`bind` › starts the cursor at the newest message…、keeps the cursor when another session rebinds。

## P2 完成：改用 lg_post

`AGENTS.md` 的“怎么发”“收到消息”两节已改写：发消息只调 `lg_post`；转交消息先 `lg_record_relayed` 存档、再执行；手工提交降级为“插件不可用”时的回退，且要在下一条消息里说明。本条 REPORT 即由本会话的模型调用 `lg_post` 发出——这就是 AC-2 的证据。

## AC-5：M2 设计方案（Global 侧，只写方案）

### 总判断

M2 不需要新的传输层：频道在 0011 之后就是 git 仓库，Global 侧的读写都能落在同一套 plumbing 上。M2 真正要解决的是把“Global 能看到什么”从提示词约定变成**组合事实**——工具不存在，比工具被禁止更可靠。

### 1. preset lg-global

只装：`persona`、`agent-instructions`（加载 `LG-ROLE.md`）、`tool-fs`（read/readImage，write 限定到 `drafts/`）、`tool-fs-search`、`tool-web`、以及 `lg_*` 工具。不装 bash、terminal、job、subagent。把 `agent-preset-registry.default` 指向它。

**但这一条单独不成立**：bundle 的 patch 层在用户 patch 层之下，用户可以在自己的 `cordis.patch.yml` 里把 default 改回带 bash 的 preset。所以预设只解决“默认安全”，真正的保证在 lg-integrity（见 §4）。

满足不变量 7 的方式是“能力不存在”而非“能力被禁”：没有 shell 工具，Global 就无法制造产物，不变量 2 的“单一写者”因此是结构性的。

### 2. lg-scope

- 文件：`ctx.tools.guard` 检查 `read`/`read_image`/`write`/`edit`/`glob`/`grep` 的路径参数，`realpath` 后必须落在 Global workspace 内；`write` 再限定到 `drafts/`。
- 工具名：deny 执行类与派生类（`bash`、`pwsh`、`terminal_*`、`job_*`、`subagent*`）。
- 网络：在 `tools/pre-execute` 里检查 `web_fetch` 目标。**默认用 allowlist，而不是 deny-private**：先解析域名再判断存在 DNS rebinding 的 TOCTOU，攻击者可让第一次解析返回公网地址、fetch 时返回内网地址。

不变量 7 靠 guard 的单调性：guard 拒绝后任何后续监听都无法放行。这一点我在 M1 已核实 `ToolGuard = (exec) => string | undefined` 且“no allow result”。

### 3. lg-repo

bare mirror + 只读 plumbing：`sync`（fetch + 硬重置到远端分支）、`log`、`diff`、`show`。**代码里没有任何 push 路径**，并且把 mirror 的 `remote.origin.pushurl` 设成无效值，做到“想推也推不了”。

凭据只给 Contents: Read（deploy key 或 fine-grained token）。daily profile 里那把能写的 SSH key 绝不能出现在 Global 的 `DSH_HOME` 里。

- 不变量 2：Global 的结论取自 mirror 里的字节，不取自 REPORT 的措辞。
- 不变量 3：`lg_repo_show` 返回原始字节，不做摘要、不做截断。

### 4. lg-integrity

启动探针 + 组合哈希 + ISOLATION_REPORT：

- 读宿主路径必须失败；访问 `127.0.0.1`/局域网必须失败；用现有凭据 push 必须失败；读频道与模型 API 必须成功。
- 哈希对象是 `--dump-config` 的**解析结果**而不是 profile 文件：文件没变但 bundle 升级同样要能被发现。哈希不符就发 ISOLATION_REPORT 并暂停工作。
- 断言 `agent-preset-registry.default === 'lg-global'` 且没有其他 preset 被启用——这正是 preset 单独做不到的那一条。

### 5. 不变量对照

| 不变量 | 主要承载者 | 机制 |
|---|---|---|
| 2 汇报是声明，产物是证据 | lg-repo + preset | Global 只能读 mirror；结论必须落到某个 commit 的字节上 |
| 3 证据物化 | lg-repo + lg-scope | show 返回原始字节；证据必须从 mirror 读，不接受转述 |
| 7 隔离由代码强制 | lg-scope + lg-integrity | 单调 guard + 启动探针 + 组合哈希；不靠模型自觉 |

### 6. implementation.md 里我认为不成立或要改的地方

1. **§preset lg-global 的“界面里无法切换到其他 preset”不成立**。bundle 的 patch 在用户 patch 之下，`agent-preset-registry.default` 可被用户覆盖。改法：由 lg-integrity 启动断言并拒绝工作。
2. **§隔离策略“正向隔离在规则层就很强”偏乐观**。dsh 自身的进程 sandbox 不拦读取（文档 §“两条要注意的边界”自己也承认），所以“Global 看不到 Local”全压在插件 guard 上；任何不经工具的文件访问都绕过它。改法：把“Global 与 Local 不同 DSH_HOME、不同系统用户”从可选升为 M2 部署前提。
3. **§lg-scope 的网络检查有 TOCTOU**（DNS rebinding）。改法：默认 allowlist，或解析后固定 IP 再发请求。
4. **§lg-repo 的“只读镜像”是约定不是事实**。bare mirror 带 origin pushurl，环境里若有写凭据仍然可写。改法：pushurl 置空 + 只读凭据 + 启动探针实测 push 失败。
5. **§证据规范的 `environment: real` 是自报字段**，Global 无法验证 Local 是否真在目标环境跑过。改法：`real` 必须附带只有目标环境能产生的探针输出（宿主版本、签名），否则一律按 simulated 处理。
6. **§lg_stop 与 mirror 的时间差**：`lg_stop` 要在“每条验收标准都有 real 证据”上判定，但 mirror 可能是旧的。改法：`lg_stop` 内部先 sync 再比对 `final_commit`，否则会对着旧 commit 验收。

### 7. M2 交付与验收建议

交付 `@local-global/dsh-lg-global`（preset + scope + repo + integrity 四个插件），仍不发布 npm。验收建议沿用 M1 的做法：先写探针确认 dsh 0.2.1-rc.2 的 `agent-preset-registry`、`tools.guard`、`tools/pre-execute`、`agent-instructions` 四个接口的真实形状，再做负面验收——“该失败的必须失败”比“该成功的成功”更能证明隔离。

## 偏离登记

1. **0018 的归档被改写过一次**。我抄错最后一句（“构建顺序的问题误判成逻辑错误”写成“构建顺序当成逻辑错误”），发现后 amend 并 force push，`main` 从 `2f64f40` 变 `2e9ac95`，现在与原文逐字节一致。这违反“只追加”，如实登记。
2. **0015 与 0017 的 resolves 用了旧格式**（裸 `F-4`），按当前校验器它们是 INVALID。本条按 `0014/F-4` … `0014/F-10`、`0016/F-11`、`0018/F-12` 补登，原消息保持原样。
3. **指令版本**：本条对应 DIRECTIVE v2，但频道里 0005 的 `version` 仍是 1——v2 是 Human 直接转交的，没有经过频道。若你认为需要一条正式的 v2 DIRECTIVE 入频道，我可以补发（那会是我用 lg_post 发的第二条消息）。
