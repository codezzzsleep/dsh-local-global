# M2 P2：四个 dsh 接口的探针结果

dsh `0.2.1-rc.2`，安装根目录 `/opt/deepseek-harness/node_modules/@deepseek-ai/`。
探针插件 `packages/dsh-lg-global/probe/` 装进 profile `lg-global-m2`（`DSH_HOME=~/.dsh-global-m2`）后运行，
原始输出 `evidence/M2/probe-raw.json`，启动日志 `evidence/M2/probe-boot.log`。

## 1. agent-preset-registry

| 项 | 值 |
|---|---|
| 服务 | `ctx.agentPresets`（`dsh-agent-preset-registry/lib/types/index.d.ts:31` 声明 `Context.agentPresets`） |
| 实现 | `dsh-agent-preset-registry/lib/index.js:393`（`class AgentPresetRegistry`） |
| 配置 | `default`（必填）、`selectedDefault`（volatile，默认 `{}`） |

探针观察：

```json
{
  "defaultId": "standard",
  "config": { "default": "standard", "selectedDefault": {} },
  "methods": ["composedPreset", "inspectCompositions", "list", "readDocument",
              "register", "remoteExportList", "select", "serviceFor", "..."]
}
```

- `defaultId` 是 getter（`lib/index.js:463`），返回当前生效的默认 preset。**注意**：`selectedDefault` 是用户级覆盖，
  新会话解析时优先于部署 `default`——所以 lg-integrity 必须同时断言 `defaultId`，而不是只看配置里的 `default`。
- `list()`（`lib/index.js:570`）返回每个声明的 `{id, broken, name?}`；`remoteExportList()`（`lib/index.js:585`）
  在此基础上补 `isDefault`。lg-integrity 用这两个就能判断“默认是不是 lg-global、还有没有别的 preset 活着”。
- `inspectCompositions(ctx)`（`lib/index.js:559`）返回**活着的 agent** 的组合清单；未创建 agent 时返回 `[]`（探针实测）。
  所以它不能用来做启动断言，只能用于已有会话的复核。

对实现的影响：preset 断言放在 `defaultId` + `list()` 上；`selectedDefault` 若是非空对象也要报。

## 2. tools.guard

| 项 | 值 |
|---|---|
| 声明 | `dsh-tools/lib/types/index.d.ts:522`（`type ToolGuard`）、`:656`（`guard()`） |
| 实现 | `dsh-tools/lib/index.js:3017` |
| 签名 | `(execution: Readonly<ToolExecution>) => string \| undefined`，同步；返回理由即拒绝 |

探针观察（`evidence/M2/probe-raw.json`）：

```json
"toolOk":     { "isError": false, "value": "ok" },
"toolDenied": { "isError": true,  "error": { "message": "probe guard denies this tool" } },
"ordering":   ["pre-execute:probe_ok", "guard:probe_ok", "execute:probe_ok",
               "pre-execute:probe_deny", "guard:probe_deny"]
```

- 守卫在 `tools/pre-execute` 之后运行（`dsh-tools/lib/index.js:3321` 的 waterfall 之后）。
- 被拒绝的那次 `execute:probe_deny` **没有出现**——工具体根本没执行。
- 守卫没有“允许”返回值，只有拒绝理由或 `undefined`，所以监听顺序无法把拒绝翻回来。

对实现的影响：lg-scope 的路径检查、lg-integrity 的 push 探针都可以放在守卫里；但守卫必须同步，凡是需要 `await` 的
（DNS 解析、`realpath` 之外的 IO）只能放 pre-execute。

## 3. tools/pre-execute

| 项 | 值 |
|---|---|
| 声明 | `dsh-tools/lib/types/index.d.ts:64`（事件）、`:216`（`ToolExecutionInput`，`signal` 必填） |
| 实现 | `dsh-tools/lib/index.js:3321` |
| 签名 | `(exec, next) => Promise<PreToolDecision>`，waterfall |

探针观察：监听器在守卫之前被调用，`next()` 之后继续；返回 `{kind:'allow'}` 即放行。

对实现的影响：lg-scope 的网络检查放在这里，因为 `web_fetch` 的域名解析是异步的。守卫不能替代它。

## 4. agent-instructions

| 项 | 值 |
|---|---|
| 配置 | `dsh-agent-instructions/lib/types/config.d.ts:13`（`Config`，`maxBytes` **必填**） |
| 实现 | `dsh-agent-instructions/lib/index.js:1222`（`apply`） |
| 关键字段 | `maxBytes`、`instructionFileCandidates`（默认 `['AGENTS.md','CLAUDE.md']`）、`localInstructionFileCandidates`、`projectRootMarkers` |

探针结果：`ctx.get('loader')` 不可达（`"loader not reachable"`），**无法从插件侧读取已装载的候选文件名**。
配置只能通过 `--dump-config` 核实；运行期效果要靠一个真实会话去看注入内容。

对实现的影响：`docs/implementation.md` 里写的 `instructionFileCandidates: ['LG-ROLE.md']` 字段名是对的，
但 `maxBytes` 是必填项，样例里给了 65536，必须保留。lg-integrity 若要断言“LG-ROLE.md 确实被加载”，
只能创建会话后看上下文，不能从插件配置里读——这一点要在 M2 的正面验收里处理。

## 与方案的差异

方案（0019）里假定可以“枚举 Global 会话可见的全部工具”并“断言 preset”。探针确认两者都有可用入口
（`ctx.tools.schemas()` 与 `agentPresets.list()/defaultId`），但有一个方案没预料到的点：
`selectedDefault` 是**用户级覆盖**，优先级高于部署 `default`。lg-integrity 必须断言 `defaultId` 的实际值，
不能只比对配置字段，否则用户改一个 volatile 字段就能绕开。
