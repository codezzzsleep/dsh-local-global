[LG REPORT from local]
commit: 478bd09184b4193890be819552f21f6130636011
directive_version: 3
evidence:
  - evidence/M2/probes.md
  - evidence/M2/probe-raw.json
  - evidence/M2/probe-boot.log
  - evidence/v2/session-lg-post-0019.jsonl
negative_tests: []
refs:
  - "0025"
---
## P1：已完成（在 0024 里交过）

上一条 REVIEW 的 F-1、F-2、F-3 与 docs 修改都在 `0024` 里：DIRECTIVE v2 存档为 `0023`、AGENTS.md 增“只追加 / 不 force push”、AC-2 的会话记录导出为 `evidence/v2/session-lg-post-0019.jsonl`，docs 按六条决定改完（commit `6bf5b1d`）。本条不再重复。

## P2：四个接口的探针

探针插件 `packages/dsh-lg-global/probe/` 装进 profile `lg-global-m2`（独立 `DSH_HOME=~/.dsh-global-m2`）实跑，
原始输出 `evidence/M2/probe-raw.json`，说明与源码路径 `evidence/M2/probes.md`（commit `478bd09`）。

| 接口 | 源文件 | 探针结论 |
|---|---|---|
| `ctx.agentPresets` | `dsh-agent-preset-registry/lib/index.js:393`；声明 `lib/types/index.d.ts:31` | `defaultId`（`:463`）返回生效默认值；`list()`（`:570`）给 `{id,broken}`；`remoteExportList()`（`:585`）补 `isDefault`；`inspectCompositions()`（`:559`）只对活着的 agent 有结果，未建会话时为 `[]` |
| `ctx.tools.guard` | `dsh-tools/lib/index.js:3017`；声明 `types/index.d.ts:522/656` | 同步、单调。实测被拒工具返回 `isError:true` 且**工具体从未执行**，`ordering` 里没有 `execute:probe_deny` |
| `tools/pre-execute` | `dsh-tools/lib/index.js:3321`；声明 `types/index.d.ts:64/216` | waterfall，在守卫之前运行；`next()` 放行 |
| `agent-instructions` | `dsh-agent-instructions/lib/index.js:1222`；配置 `types/config.d.ts:13` | `instructionFileCandidates` 字段存在，但 **`maxBytes` 是必填**；插件侧读不到已加载的候选文件（`ctx.get('loader')` 不可达），只能靠 dump-config 与真实会话验证 |

## 方案与实现对不上的两处

1. **`selectedDefault` 是用户级覆盖，优先级高于部署 `default`。** 0019 的方案只说“断言 `agent-preset-registry.default`”，照做会被一个 volatile 字段绕开。lg-integrity 改为断言**运行时的 `defaultId`**，并在 `selectedDefault` 非空时报 ISOLATION_REPORT。
2. **`inspectCompositions()` 不能用于启动断言**（没有活会话时恒为 `[]`）。启动阶段只能用 `defaultId` + `list()`；组合清单只在有会话时复核。

这两点不改变方案结构，但要改动实现细节，先报给你，不自己绕过去。

## 下一步

P3 开工：先写 `dsh-lg-global` 的四个插件骨架，再按 AC-3 逐条做负面验收（配 AC-4 的对照）。第一个能跑的里程碑会是“读 Local 工作目录被拒 + 读 workspace 内文件成功”这一对。
