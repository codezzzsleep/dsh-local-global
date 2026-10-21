# M2 用到的 dsh 接口

每一条都是本里程碑实际调用过的接口，给出源文件路径与行号（`dsh 0.2.1-rc.2`，`/opt/deepseek-harness/node_modules/@deepseek-ai/`）。

| 接口 | 位置 | 本仓库谁在用 |
| --- | --- | --- |
| `ctx.tools.register(definition)` | `dsh-tools/lib/index.js:2974` | `lg_integrity_check`、`lg_repo_*`、`lg_evidence_session` |
| `ctx.tools.guard(fn)` | `dsh-tools/lib/index.js:3017`（派发处 `:2745`） | `lg-scope` 的同步守卫；SPEC 要求网络最终判定必须在同步守卫里 |
| `tools/pre-execute`（waterfall） | 类型 `dsh-tools/lib/types/index.d.ts:47` | `lg-scope` 做异步域名解析、绑定 callId 与 url；SC-7 的测试插件 prepend |
| `PreToolDecision` 取值 | `dsh-tools/lib/types/index.d.ts:445` | `{kind:'allow'}` / `{kind:'deny',reason}` |
| `ToolRunContext.agent` | `dsh-tools/lib/types/index.d.ts:302` | 取会话的 cwd 与 id |
| `ctx.agents.create(options)` | `dsh-agent/lib/index.js:453` | driver 建 preset 作用域内的真实会话 |
| `ctx.agents.get(id)` | `dsh-agent/lib/index.js:596` | `lg-channel` 找绑定会话 |
| `agent.followup / steer / cancel` | `dsh-agent-loop/lib/index.js:806 / 809 / 815` | `lg-channel` 投递消息；driver 发起回合 |
| `ctx.agentPresets.mount(ctx,id)` | `dsh-agent-preset-registry/lib/index.js:686` | driver / 探针把 preset 挂进 agent 作用域 |
| `ctx.agentPresets.select(agent,id)` | 同上 `:750` | 同上 |
| `ctx.agentPresets.list()` | 同上 `:570` | `lg-integrity` 的注册表断言 |
| `ctx.agentPresets.inspectCompositions()` | 同上 `:559` | 同上（组合核对） |
| `ctx.agentPresets.acquireScope(id)` | 同上 `:775` | `lg-integrity` 枚举 preset 作用域里的工具 |
| `ctx.provide(name,value)` / `ctx.get(name)` | `cordis/lib/types/reflect.d.ts:43 / 16` | `lg-scope` 发布 `lgWorkspace`；`lg-channel` 发布 `lgChannel`；`lg-integrity` 读它们 |
| 会话创建元数据 `meta.cwd` | `dsh-session/lib/types/index.d.ts:397`、`:143` | `lg-scope` 读 `session.header.cwd` 决定相对路径的基准 |
| 会话事件存储 `<DSH_HOME>/sessions/<workspace>/<id>/session.v4.jsonl[.zstd]` | `dsh-session-persistence-jsonl/lib/index.js`（`compressionSuffix` `:753`） | `lg_evidence_session` 逐字节导出原始事件 |

## 一处实测结论

- `Preset services require isolate realms`：在 preset 内部发布服务会被拒绝。因此 `lg-role` 不能把自己的角色文件路径作为服务传出，`lg-integrity` 改为按同样规则自行推导路径。这条是实测得到的形状，不是猜测。
