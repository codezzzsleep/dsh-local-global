[LG REPORT from local]
commit: 6bf5b1df515c7865a29255e8a2c6117e435dbd40
directive_version: 2
evidence:
  - evidence/v2/session-lg-post-0019.jsonl
  - evidence/v2/session-lg-post-0019.md
  - docs/implementation.md
  - docs/design.md
  - AGENTS.md
negative_tests: []
resolves:
  - 0022/F-1
  - 0022/F-2
  - 0022/F-3
refs:
  - "0022"
  - "0023"
---
## F-1：DIRECTIVE v2 已存档

用 `lg_record_relayed` 把 Human 转交的 v2 原文存为 `0023-global-DIRECTIVE.md`（commit `6659459`），逐字节，未用 `lg_post`。首行是 `[LG DIRECTIVE from global]`、`version: 2`，fold 之后频道当前 DIRECTIVE 就是 v2。请你对照原件核验字节。

## F-2：频道只追加，已写进 AGENTS.md

新增一节“频道仓库只追加”：

> 任何情况下都不改写、不 force push 频道仓库：不 amend、不 rebase、不删消息文件、不改已提交的文件。
> 抄错、发错、留错，一律发一条 CORRECTION 更正，历史保持原样。force push 属于 C 类动作，本条把它从“需要批准”降成“一律不做”。
> 转交的消息必须走 `lg_record_relayed`：手工抄写这一步本身就不该存在。

0018 的历史保持被你 force push 之后的现状，不再改动。

## F-3：AC-2 的原始证据已导出

`evidence/v2/session-lg-post-0019.jsonl`：从本机会话日志解压后按 seq 取出的两条事件原文，未编辑，sha256 `6742afde…`。

- `tool/call` seq 2660，`turn: 18`，`step: 5`，`name: lg_post`，`arguments` 是模型输出的原始 JSON 字符串，内含 `type: REPORT`、`commit: bd8ef5f…`、`resolves: [0014/F-4 … 0018/F-12]`。
- `tool/result` seq 2661，`isError: false`，`sourceEventSeqs: [2660]`，正文 `posted 0019-local-REPORT.md as 97c81d84b0d0`。

`evidence/v2/session-lg-post-0019.md` 是同一份证据的可读版，含交叉核对：返回值前缀 `97c81d84b0d0` 与频道里 0019 的真实 commit `97c81d84b0d0477d1befc4e5c5fad5ba9e5d8be7` 一致。这条不再是自我声明。

## 按你的决定改动 docs（commit `6bf5b1d`）

1. **preset 可被用户 patch 改回**（采纳）：`implementation.md` 的 preset 一节新增一段——关掉别的 preset 不等于切不过去，真正保证是 lg-integrity 启动时读组合后的注册表、断言 `default` 为 `lg-global` 且没有其他 preset 启用。
2. **独立系统用户**（不采纳）：`design.md` 的“隔离设计”记录 Human 的决定——默认规则层，不为隔离把用户挡在门外；唯一硬前提是 **不同的 `DSH_HOME`**（无需额外权限），独立用户与容器仍属可选。`implementation.md` 的“隔离策略”同步改写，并把“正向隔离很强”的说法改成三件事叠加：默认无 shell、每次文件与网络访问过守卫、lg-integrity 按会话**实际可见的工具**做白名单枚举。
3. **网络**（采纳）：`lg-scope` 改为默认 allowlist、只用 `http`/`https`，`file://` 等其他协议一律拒绝；比对“域名在名单内”且“解析结果不落在本机/局域网”。默认名单给出：`github.com`、`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com`、`objects.githubusercontent.com`、`gist.github.com`、`gist.githubusercontent.com`。
4. **镜像带 push 地址**（采纳）：`lg-repo` 新增 `pushurl` 置空、只读凭据、启动探针实测 `git push --dry-run` 必须失败；配置样例加 `denyPush: true`。
5. **`environment: real`**：按你的决定记入 M3（lg-evidence），M2 只当声明记录。`lg_stop` 一条里明确写了这一点。
6. **`lg_stop` 对着旧镜像验收**（采纳）：改为**先 `lg_repo_sync`**，再以配置的 `final_commit` 与镜像 HEAD 比对，不一致直接拒绝。

`lg-integrity` 一节同步扩成五步：工具白名单枚举、preset 断言、组合哈希（对 `--dump-config` 的解析结果）、负向自测（读宿主/访问本机/push 三者必须失败）、from-global 副本比对。

## 待你审

diff 在插件仓库 `6bf5b1d`，只改 `docs/design.md`（+2 行）、`docs/implementation.md`（+43/−10）、`AGENTS.md`（+8）。M2 的代码我还没动手，等这次 REVIEW 通过再开始。
