[LG REPORT from local]
refs: ['0014']
commit: 89ede2834eca90adac54641e8fb702ba3cccd63e
directive_version: 1
evidence:
  - evidence/M1/dsh-interfaces.md
  - evidence/M1/lg-m1-cordis.patch.yml
  - evidence/M1/test.txt
  - evidence/M1/e2e.md
  - evidence/M1/e2e-evidence.jsonl
  - evidence/M1/e2e-channel-log.txt
negative_tests:
  - 0011/F-1 已解决时，0014/F-1 仍为未解决（跨 REVIEW 同号不串）
  - 提交作者取自本机 git 身份，而非消息发送者
  - 字段非法的中转消息照样原样存档，由读取方标 INVALID
resolves: ['F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9', 'F-10']
---
## F-4（blocking）bundle 不再含环境配置

`packages/dsh-lg-common/cordis.patch.yml` 现在只插入两行，注释里给出用户该怎么配：

```yaml
- insert:
    - id: lg-channel
      name: '@local-global/dsh-lg-common/channel'
    - id: lg-commands
      name: '@local-global/dsh-lg-common/commands'
```

测试配置移到 profile 自己的覆盖层，文件作为证据提交：`evidence/M1/lg-m1-cordis.patch.yml`（`repo: file:///tmp/lg-m1-channel.git`、`role: local`、`pollSeconds: 10`、`relay: true`）。装后 dump 里 `lg-channel` 的 config 来自这一层而不是 bundle。任何人装这个包，不配 `repo`/`role` 就起不来，不会再悄悄指向 /tmp。

## F-5（blocking）提交改用本机 git 身份

`commitFile` 不再注入 `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME`，只重定向 `GIT_INDEX_FILE`，作者与提交者取自本机 git 配置。重跑后的测试频道：

```text
4803b21 codezzzsleep <codezzzsleep@gmail.com> msg 0007 global DIRECTIVE
5fd6d51 codezzzsleep <codezzzsleep@gmail.com> msg 0006 human HALT
...
```

七条提交作者全部是 `codezzzsleep`。发送者身份只由首行与文件名声明，与 §9 一致。新增用例 `channel-runtime.test.ts › commit identity`：在镜像里设 `Machine User`，断言提交作者是它，而不是消息发送者 `local`。

## F-6（blocking）findings 按 REVIEW 作用域解析

契约改成 `resolves` 写 `<REVIEW 序号>/F-<n>`（例 `0011/F-1`），`foldState` 用同样的键比较，跨 REVIEW 的同号 finding 不再互相顶掉。负测：`fold.test.ts › does not resolve another REVIEW that reuses the same finding id`——0011/F-1 已解决时，0014/F-1 必须仍在未解决列表里（顺序为 `['0011/F-2', '0014/F-1']`）。

契约同步更新了字段说明，并写清“每条 REVIEW 的 finding 都从 F-1 起编，只写 F-1 会误伤”。

## F-7（minor）契约与代码对齐

按你的倾向选了“序号登记”：

- `consumed_approvals` 的语义在 §7 写明是**已用掉批准的那条 DECISION 的序号**，不是动作指纹；指纹只用于匹配命令。
- `DECISION.answers` 契约改为**序号列表**（代码与测试一直是列表）。

两处都只改契约，代码不动，因为代码侧已经是这个语义。

## F-8（minor）类型与接口清单

清单在 `evidence/M1/dsh-interfaces.md`：16 个接口，每个给出类型声明文件与实现文件（含行号）。摘要：

| 接口 | 实现位置 |
|---|---|
| `ctx.tools.register` / `execute` | `dsh-tools/lib/index.js:2974` / `:3212` |
| `ctx.commands.register` / `execute` | `dsh-commands/lib/index.js` / `:327` |
| `ctx.agents.get` | `dsh-agent/lib/index.js:596` |
| `agent.followup` / `steer` / `cancel` | `dsh-agent-loop/lib/index.js:806` / `:809` / `:815` |
| `ctx.effect` / `ctx.on` / `ctx.logger` | `cordis/lib/index.js` |

`as never` 全部移除，只剩三处断言，各自写明理由：`sessionId as SessionId`、`randomUUID() as UserMessage['id']`（两者都是运行时为 string 的 brand 类型），以及工具定义对象 `as ToolDefinition`（`parameters` 是原始 JSON Schema 而非 DSL 编译产物，泛型推不出来）。

## F-9（minor）版本范围对齐

`peerDependencies` 全部改为与 `engines.dsh` 一致的 `>=0.2.1-rc.2 <0.3.0`，并补上实际用到的 `@deepseek-ai/dsh-session`。

## F-10（minor）中转只要求首行可解析

`lg_record_relayed` 不再校验字段，字段不合格的消息照样原样入库，由读取方标 `[LG INVALID #<序号>]`。只有首行无法解析时才拒绝——文件名要从首行生成，没有别的办法。契约 §8 补了这条，并说明这是协议升级期的必要条件。负测：`channel-runtime.test.ts › archives a message whose fields it cannot validate`，用一条缺 `verdict` 的 REVIEW，断言存档字节与输入完全相同、且 `validateMessage` 会报 `missing-field`。

## 顺带发现并修掉的一个测试陷阱

`dsh-lg-common` 的测试 import `@local-global/lg-protocol` 时解析到的是**旧的 `lib/` 构建产物**。第一次跑 REVIEW 用例时 `REVIEW` 被判成 `unknown-type`，但失败信息看起来像校验逻辑写错。已加 `packages/dsh-lg-common/vitest.config.ts`，把该包别名到 `../lg-protocol/src/index.ts`，测试不再依赖构建顺序。

## 重跑结果

- `pnpm install` / `pnpm -r build` / `pnpm -r test`：**70 个用例全过**（61 + 9），无错误无警告，见 `evidence/M1/test.txt`。
- E1–E8 全部重跑通过（F-4、F-5 改变了配置来源与提交身份，旧结果已作废），见 `evidence/M1/e2e.md`。
- AC-3 三份 dump 更新：装前 1229 行、装后 1240 行、卸后 1229 行且与装前 `diff` 相同。

## 待你判定

E1–E8 的会话仍由脚本经 `ctx.agents.create()` 创建，不是网页点击，这一点与 0013 相同。若你要求网页人工记录，我另跑一轮 Playwright。
