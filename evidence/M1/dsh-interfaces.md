# F-8：用到的 dsh 接口与本机源文件位置

dsh 版本 `0.2.1-rc.2`，安装根目录 `/opt/deepseek-harness/node_modules/@deepseek-ai/`。
下表是 `dsh-lg-common` 与 `lg-protocol` 实际调用到的每一个 dsh 接口。

| 接口 | 类型声明 | 实现位置（行号为 0.2.1-rc.2） | 用途 |
|---|---|---|---|
| `ctx.tools.register(definition)` | `dsh-tools/lib/types/index.d.ts:637` | `dsh-tools/lib/index.js:2974` | 注册 `lg_post`、`lg_record_relayed`、`lg_read`、`lg_open_questions` |
| `ctx.tools.execute(exec)` | `dsh-tools/lib/types/index.d.ts:766` | `dsh-tools/lib/index.js:3212` | E2E 驱动按模型工具调用的同一路径触发工具 |
| `ToolExecutionInput`（含必填 `signal`） | `dsh-tools/lib/types/index.d.ts:216` | — | 工具调用入参；缺 `signal` 会抛 `Cannot read properties of undefined (reading 'aborted')`，E2E 首次失败即此原因 |
| `ctx.commands.register(definition)` | `dsh-commands/lib/types/index.d.ts:94` | `dsh-commands/lib/index.js`（`CommandRuntime.register`） | 注册 `/lg-bind`、`/lg-status`、`/lg-halt` |
| `ctx.commands.execute(agent, line, attachments, signal)` | `dsh-commands/lib/types/index.d.ts:142` | `dsh-commands/lib/index.js:327` | 命令的实际执行路径（Web 适配器同款） |
| `ctx.agents.get(id)` | `dsh-agent/lib/types/index.d.ts` | `dsh-agent/lib/index.js:596` | 由绑定的 session id 取回 live Agent |
| `agent.followup(message)` | `dsh-agent/lib/types/runtime-types.d.ts:192` | `dsh-agent-loop/lib/index.js:806` | 会话空闲时投递频道消息 |
| `agent.steer(message)` | `dsh-agent/lib/types/runtime-types.d.ts:200` | `dsh-agent-loop/lib/index.js:809` | 会话运行中投递频道消息 |
| `agent.cancel(cause, options?)` | `dsh-agent/lib/types/runtime-types.d.ts:157` | `dsh-agent-loop/lib/index.js:815` | 收到 HALT 时中止当前回合 |
| `agent.status` | `dsh-agent/lib/types/runtime-types.d.ts` | `dsh-agent-loop/lib/index.js` | 决定 steer 还是 followup |
| `agent.session.id` | `dsh-agent/lib/types/runtime-types.d.ts` | — | `/lg-bind` 记录绑定目标 |
| `UserMessage` / `ContentBlock` | `dsh-llm/lib/types/message.d.ts:144` | — | 投递消息的结构 |
| `SessionId`（branded string） | `dsh-session/lib/types/types.d.ts:12` | — | `agents.get` 的键类型 |
| `ctx.effect(callback)` | `cordis/lib/types/fiber.d.ts:8` | `cordis/lib/index.js` | 轮询定时器的生命周期与卸载 |
| `ctx.on('session/event', …)` | `dsh-session/lib/types/index.d.ts:61` | `dsh-session/lib/index.js` | E2E 证据里记录会话事件 |
| `ctx.logger(name)` | `cordis/lib/types/context.d.ts:30` | `cordis/lib/index.js` | 轮询失败告警 |

## 类型断言清单（保留的每一处及理由）

| 位置 | 断言 | 理由 |
|---|---|---|
| `channel.ts` `boundAgent()` | `sessionId as SessionId` | 绑定值从 JSON 状态文件读出，是普通 string；`SessionId` 是运行时为 string 的 brand 类型，只能靠断言跨过品牌边界。 |
| `channel.ts` `inject()` | `randomUUID() as UserMessage['id']` | 同上：`MessageId` 是 brand，运行时就是 uuid 字符串。 |
| `channel.ts` 工具定义 | `as ToolDefinition` | 手写的定义对象结构与 `defineTool` 产物一致，但 `parameters` 是原始 JSON Schema 而非 DSL 编译结果，泛型推断无法自动收敛。 |

除此之外不再有 `as never`：`agent.steer/followup` 收 `UserMessage`、`agent.cancel({ kind: 'user' })` 直接匹配 `AgentCancelCause`、`agents.get` 收 `SessionId`。

## 为什么运行时只 `import type`

`lg-m1` 这类 profile 的 `pnpm-workspace.yaml` 带 `autoInstallPeers: false`，peer 依赖不会装进 profile。
实测把 `import { defineTool } from '@deepseek-ai/dsh-tools'` 放进 bundle 会得到：

```text
lg-probe (@local-global/probe-bundle): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-tools'
```

所以 bundle 对 dsh 只有类型依赖，运行时全部通过 `ctx` 服务访问。
