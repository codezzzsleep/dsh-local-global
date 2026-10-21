# 只读审查：边界问题分级结论

基线 `5fae831`（M3 验收通过时的 HEAD）。本轮为**只读**审查：不改业务代码、不提交插件仓库。
每条都给出精确位置、触发条件、我的复现方式与判定；**不采信转述**，逐条自己验。

方法：读源码定位 → 构造最小复现（真实 Git / 真实文件系统 / 直接调用被测函数）→ 判定。
对每条注明"我复现到了什么程度"（读码即证 / 实测复现），不把"像是"写成"是"。

---

## 结论一览

| # | 声称 | 判定 | 严重度 |
| --- | --- | --- | --- |
| 1 | Global git 参数可读取 workspace 外文件 | **证伪** | — |
| 2 | `cd` 后守卫采用创建时 cwd | **属实** | 高 |
| 3 | 证据导出可覆盖角色文件 | **属实** | 高 |
| 4 | 首次工具调用无检查完成屏障 | **证伪** | — |
| 5 | 非法消息进入审批状态 | **属实** | 中 |
| 6 | 跨角色 `supersedes` 绕过 HALT | **属实** | 高 |
| 7 | 批准不真正消耗 | **属实** | 中 |
| 8 | 证据内部 shell 绕过守卫 | **属实**（有范围限制） | 低 |
| 9 | PATCH 冲突覆盖未提交工作 | **属实** | 高 |
| 10 | 独立安装失败 | **属实，但标签是错的**（是 `dsh-lg-local` 而非 common） | 低 |

---

## 逐条

### 1. Global git 参数可读取 workspace 外文件 —— 证伪

`lg_repo_show(commit, path)` 把 `path` 交给 `git show <commit>:<path>`。实测：

```text
$ git -C /tmp/gitesc show HEAD:a.txt                     → ok
$ git -C /tmp/gitesc show HEAD:../../../tmp/outside.txt  → fatal: '…' is outside repository
```

git 自身拒绝工作树外的路径。**不是缺陷。**

### 2. `cd` 后守卫采用创建时 cwd —— 属实（读码即证）

- 守卫：`checkPath(config, tool, rawPath, sessionCwd(exec.agent))`，而 `sessionCwd` 读 `session.header.cwd`——会话的**冻结创建元数据**。
- `working_directory` 工具改的是 `ctx.workingDirectory.set(agent, cd)`。

两者不是同一个字段。**触发条件**：会话先 `working_directory cd` 到 workspace 外的目录，再用相对路径 `read`/`glob`/`grep`——工具按**当前** cwd 解析，守卫按**旧** cwd 判定，于是相对路径的实际落点可以越出 workspace 而守卫看不出来。这直接绕过 SC-3。

### 3. 证据导出可覆盖角色文件 —— 属实（读码即证）

`checkPath` 的写权限规则只在工具名恰为 `write` / `edit` 时生效：

```ts
if (tool === 'write' || tool === 'edit') { /* writeRoots 检查 */ }
```

`lg_evidence_session` 经 `TOOL_PATH_ARGUMENTS` 走另一条分支，只查"在 workspace 内"。而 `LG-ROLE.md` 就在 workspace 里。**后果**：Global 会话能改写自己的角色文件——RL-1 的前提（指令只来自角色文件）被自己推翻。

### 4. 首次工具调用无检查完成屏障 —— 证伪

`results` 是**每次调用各自一份**的 `Map`（`integrity.ts:258`），启动检查与 `lg_integrity_check` 之间不存在共享状态竞争；而进程启动即 `not-verified` 暂停，守卫拒绝除 `lg_integrity_check` 外的一切调用（PS-1 / IN-1 的会话证据也实测如此）。**不是缺陷。**

### 5. 非法消息进入审批状态 —— 属实（读码即证）

`refreshApprovals()` 用 `foldState(await this.all()).approvals`。`all()` 只过滤**解析失败**的消息，**不过滤校验失败**的消息。于是"能解析但字段非法"的 DECISION 仍会贡献 `approve_action`，进入内存批准表。**后果**：一条非法消息可以授权一次 C 类动作。

### 6. 跨角色 `supersedes` 绕过 HALT —— 属实（读码即证）

`deliverOne` 里的顺序是：先算 `dead`（是否有消息 `supersedes` 了它）→ 是就投递 `SUPERSEDED … 不要执行` 并 `return`；**之后**才是 HALT 分支。

而 `dead` 的计算只看 `supersedes` 的**值**，不检查发出者是否与被替代者同角色（`checkIdentities` 会报 `foreign-supersedes`，但那条路不参与投递）。**后果**：一条消息（哪怕来自另一角色）只要 `supersedes` 了 HALT，HALT 就**不会执行**——停止指令被绕过。

### 7. 批准不真正消耗 —— 属实（读码即证）

`lg-action-gate` 放行一次后把用掉的 DECISION 记在**进程内数组**里，从不写回频道；而批准表每次 fetch 都由 `foldState` 重算，`foldState` 只把**被某条 REPORT 的 `consumed_approvals` 登记过**的 DECISION 扣除。**后果**：只要模型不登记，同一条 DECISION 可以反复授权同一动作，与"每次批准只用一次"直接冲突。

### 8. 证据内部 shell 绕过守卫 —— 属实（范围有限）

`lg_evidence_add` 用 `spawnSync('/bin/sh', ['-c', command])` 执行任意命令，而守卫只看**工具名**（`bash`/`pwsh`/`terminal`/… 前缀），不会看某个插件内部起了什么。**范围**：`lg-evidence` 属于 `dsh-lg-local`；它没被装进 Global 沙箱 profile，所以当前不构成越权。**若**把 `dsh-lg-local` 组进 Global profile，GS-1（会话里没有 shell）在实质上被推翻——一个名字不像 shell 的工具就是 shell。

### 9. PATCH 冲突覆盖未提交工作 —— 属实（实测复现）

`applyPatch` 在 `git am` 失败后执行 `git am --abort` + `git checkout -- .`。实测：

```text
提交前：f.txt = "尚未提交的珍贵改动"
执行 git checkout -- .
提交后：f.txt = "base"          ← 未提交的改动被丢弃（未跟踪文件不受影响）
```

**后果**：一次冲突回滚会顺手毁掉工作区里**与该补丁无关**的未提交改动。回滚应只撤销补丁自己的效果。

### 10. 独立安装失败 —— 属实，但标签错了

- `dsh-lg-common`：无 `workspace:` 依赖，`dsh.bundle` 齐备 → **可以**独立安装。
- `dsh-lg-local`：`"@local-global/lg-protocol": "workspace:*"` → 出 monorepo（打 tarball 安装）无法解析 → **装不上**。

真正有问题的包是 `dsh-lg-local`，不是声称里的 common。这条标签要按实纠正。

---

## 修复顺序建议

1. **先修四条不变量**（都可被模型自身触发、且互相叠加）：#3 角色文件可被覆盖、#2 守卫 cwd 过期、#6 跨角色 supersedes 绕过 HALT、#9 冲突回滚丢改动。
2. **再修两条状态正确性**：#5 非法消息进批准表、#7 批准不真正消耗——它们共同决定"C 类动作的授权是否可信"。
3. **最后收尾两条工程性**：#8（若确实要让 dsh-lg-local 进 Global profile，`lg_evidence_add` 必须走守卫认可的路径）、#10`workspace:*` 换掉。
4. 每修一条**配一个回归用例**：这十条里八条能写进单测（#9 用真实 git 可测；#2、#6 需要端到端会话）。

## 一句总结

**八条属实、两条证伪。** 它们都在"已经通过 M2/M3 验收"的代码里：当时的验收证明了**规格点名的情形**，但没有覆盖这些边界。这不推翻既有验收（那是对着需求条目做的），但说明"全绿单测"不等于"边界已覆盖"——这个区分我照实写，不粉饰。
