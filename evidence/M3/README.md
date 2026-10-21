# M3 验收证据索引

对应 DIRECTIVE v5（频道 `0063`）的 AC-1 至 AC-8。环境：dsh `0.2.1-rc.2`、node `v24.22.0`、
pnpm `11.28.5`；Local 侧验收 profile `lg-local-m3`（web app，独立 `DSH_HOME`）。

## AC 对照

| AC | 要求 | 证据 | 结果 |
| --- | --- | --- | --- |
| AC-1 | PR-6（id/supersedes，三个负测）、PR-9（0003–0039 真实消息回归）、PR-11（契约与 SPEC 一致） | `packages/lg-protocol/test/identities.test.ts`、`test/real-messages/`、`docs/channel-git.md` | PASS；并**登记了三条历史消息的旧 resolves 形状**（见下） |
| AC-2 | CH-4 / CH-9 / CH-10 真实 dsh 端到端 | `ch4-ch10-session.jsonl`、`ch9-session.jsonl`、`ch4-ch9-ch10.md` | PASS，会话原始事件 |
| AC-3 | EV-1 至 EV-5 | `ev-real/`、`ev-leaky/`、`ev4-stale-session.jsonl`、`packages/dsh-lg-common/test/evidence.test.ts` | PASS，含工具亲自执行产生的原始输出 |
| AC-4 | PA-1 四个用例 | `packages/dsh-lg-local/test/patch.test.ts` | PASS：APPLIED / REJECTED / DUPLICATE / CONFLICT（工作区已回滚） |
| AC-5 | RG-1、AG-1、AG-2、PT-1 | `packages/dsh-lg-local/test/gates.test.ts` | PASS，正反用例齐全 |
| AC-6 | `stateDir` 默认值对齐 SPEC + 迁移说明 | `packages/dsh-lg-common/test/channel-runtime.test.ts`（迁移用例） | PASS，见"迁移说明" |
| AC-7 | QA-1 至 QA-7、本索引、负面带原文与对照 | `test.txt`、`secret-scan.txt`、本文件 | PASS |
| AC-8 | 不破坏 M2：既有用例仍通过，Global 沙箱行为不变 | `test.txt` | PASS：M2 的 40 个 dsh-lg-global 用例全部仍在并通过 |

## 需求索引

| 编号 | 证据 | 命令 / 环境 | 结果 |
| --- | --- | --- | --- |
| PR-6 | `identities.test.ts` | 单元测试 | id 形状非法、前缀与发送者不符、重复 id、替代他人 id、替代不存在的 id——五个负测；`checkIdentities()` 新增 |
| PR-9 | `identities.test.ts` + `test/real-messages/` | 单元测试（真实频道原文 37 份） | 全部照常解析；`0012/0015/0017` 的旧 `resolves` 形状被钉在测试里 |
| PR-11 | `docs/channel-git.md` | 与 SPEC"消息协议"逐节对齐 | §4 补 id/supersedes 通则与 REPORT 的 resolves/checkpoint/meanwhile；§7 派生状态补到 6 项 |
| CH-4 | `ch4-ch10-session.jsonl` | 真实会话：一次投递 4 条 | `turn/start` 仅 1 次（checkpoint REPORT）；普通 REPORT 与 CLAIM 走 `agent.inject` 不开回合 |
| CH-9 | `ch9-session.jsonl` | 真实会话：游标从 0016 倒回 0000 | 0001–0012 照常投递，**0013–0016 被跳过**（id 已在 `deliveredIds`） |
| CH-10 | `ch4-ch10-session.jsonl` | 真实会话 | `[LG #0019 CLAIM SUPERSEDED by L-0020] 不要执行。` |
| EV-1 | `ev-real/manifest.json` | 真实会话：`lg_evidence_add` | 清单绑定 commit 与 digest；raw 缺失即拒绝（负测） |
| EV-2 | `ev-real/manifest.json` | 同上 | `producedByTool: true`，含命令、退出码、起止时间、主机名、dsh 版本、输出 sha256 |
| EV-3 | `packages/dsh-lg-common/test/evidence.test.ts` | 单元测试（真实 store 布局：zstd 与明文） | 导出与日志**逐字节一致**，sha256 相等 |
| EV-4 | `ev4-stale-session.jsonl`、`channel-runtime.test.ts` | 真实会话 + 单元测试 | 提交后 digest 变 `be5345a1…` → `STALE M3/ev-leaky \| STALE M3/ev-real`；引用它的 REPORT 被 `lg_post` 拒绝 |
| EV-5 | `ev-leaky/manifest.json` | 真实会话 | 含 `token=` 的文件被拒（原文入库）；打码后写入成功 |
| PA-1 | `packages/dsh-lg-local/test/patch.test.ts` | 集成测试（真实 git + 真实文件系统） | 四个结果各有用例；CONFLICT 后 HEAD 不变、无残留 `am`、文件原样 |
| RG-1 | `packages/dsh-lg-local/test/gates.test.ts` | 单元测试 | 四条件（HEAD 未报 / DIRECTIVE 版本未确认 / 证据缺清单 / 未解决 blocking）各有正反 |
| AG-1 | `gates.test.ts` | 单元测试 | 无批准被拒并给出指纹；有批准执行一次并登记；同一批准第二次被拒；指纹不跨动作转移 |
| AG-2 | `gates.test.ts` | 代码审查 + 单元测试 | `gateReason()` 把批准表作为参数（签名可查，守卫零 I/O）；表由 `ChannelRuntime.approvals()` 在内存里维护 |
| PT-1 | `gates.test.ts` | 单元测试 | read/edit/glob 指向受保护路径被拒、bash 文本点名被拒；项目文件与普通命令正常 |

## 迁移说明（AC-6）

`stateDir` 默认值从 `$DSH_HOME/lg` 改为 SPEC 配置表的 `$DSH_HOME/lg/state/<仓库标识>`。

**已绑定会话的游标怎么处理**：`StateStore.migrate()` 在启动时执行一次——若新位置**不存在**而
旧文件 `$DSH_HOME/lg/<仓库标识>.json` 存在，就把旧文件**复制**过去（游标、绑定会话、`deliveredIds`
一并保留），并打一条日志。旧文件**不移动、不删除**，回滚时仍能找到。

不这么做会怎样：新位置是空的 → 游标回到 `0000` → 按 CH-2 首次绑定会把游标设到最新序号，
**已绑定的会话会静默错过那之后到达的消息**。这条迁移是专门为堵这个而写的，有单元测试覆盖
（有旧文件 / 无旧文件 / 无 legacy 路径三种情形）。

## 三条历史消息的旧形状（已由 0066 的 REVIEW 裁决）

`0012`、`0015`、`0017` 的 `resolves` 用 v2 之前的裸 `F-<n>`。校验器**维持严格**，契约里登记
"v2 之前的消息用裸 `F-<n>`，本契约只管新消息"，测试里把这三条钉住。

## 证据导出口径

会话类证据由**模型自己**调 `lg_evidence_session` 导出；暂停或无工具语义的场景由 driver 从同一个
session store 导出，sha256 可核，逐条在需求索引里注明。
