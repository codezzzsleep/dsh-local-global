# M2 验收证据索引

对应 DIRECTIVE v4（频道 `0041`）的 AC-1 至 AC-8。环境见下表；除特别注明外全部是 **real**。

| 项 | 值 |
| --- | --- |
| dsh | `0.2.1-rc.2` |
| node / pnpm | `v24.22.0` / `11.28.5` |
| 验收 profile | `lg-global-m2`（web app），独立 `DSH_HOME=/var/lib/deepseek-harness/.dsh-global-m2` |
| 会话驱动 | `packages/dsh-lg-global/driver`（`ctx.agents.create` + `agentPresets.mount`，模型自己发起调用） |
| 证据导出口径 | 会话事件由**模型自己**调 `lg_evidence_session` 导出；暂停中的会话导不出来（守卫拒绝一切工具），那种情况由 driver 从同一个 session store 导出，并在下表标注 |

## AC 对照

| AC | 要求 | 证据 | 结果 |
| --- | --- | --- | --- |
| AC-1 | `docs/spec.md` 与 Human 交付的 SPEC v2 逐字节一致；旧文档标注冲突处以它为准 | `P1-spec.md` | PASS：sha256 `0b39ffcb…`、59542 字节、`cmp` 无差异 |
| AC-2 | RP-6：writable 暂停、denied 通过、inconclusive 只警告 | `rp6-probe.txt`、`negatives`… | PASS：本机实测 `denied`；可写测试仓库 `writable` → `pause`；单元测试覆盖三态 |
| AC-3 | lg-repo 支持 `httpProxy`；配置生效证据；单元测试覆盖解析 | `test.txt`、`repo.test.ts` | PASS：`proxyConfig()` → `-c http.proxy=` 进入每个 git 调用；解析用例正反各一 |
| AC-4 | CH-12 / IN-3：发件副本逐字节比对，篡改后暂停 | `in3-session.jsonl`、`in3-isolation-report.md` | PASS：`archived bytes differ from the saved copy (copy 866B, archive 880B)` |
| AC-5 | 真实会话的负面与对照（SC-3/SC-6/SC-7/GS-3/RL-1） | `sc3-*`、`sc6-session`、`sc7-*`、`gs3-session`、`rl1-session` | PASS，见需求索引 |
| AC-6 | 全部需求编号逐行有证据、命令、环境、结果 | 本文件 | PASS |
| AC-7 | QA-1：install 无错误无警告，build 与 test 全过 | `test.txt` | PASS：**115 个用例**（61 + 14 + 40） |
| AC-8 | QA-5、QA-6：证据绑定验收时 HEAD；提交前密钥扫描入库 | `secret-scan.txt`、`sc3-sha256.txt` | PASS |

## 需求索引

会话类证据的 sha256 见 `sc3-sha256.txt`；每份都可与 session store 里的原始文件核对。

| 编号 | 证据 | 命令 / 环境 | 结果 |
| --- | --- | --- | --- |
| GS-1 | `negatives-session.jsonl` | 模型调 `lg_integrity_check` | `ok tool-whitelist: 15 tools, all allowed`，无 shell／终端／后台任务／子 agent 工具 |
| GS-2 | `gs2-session.jsonl` | `dsh --profile m2-wrong` | `FAIL profile-name: m2-wrong`；`read` 被拒 `paused: profile-name — m2-wrong` |
| GS-3 | `gs3-session.jsonl` | overlay 重新启用另一 preset 并改默认值；端口 3117 运行前确认空闲 | `FAIL preset-registry: … got: lg-global, standard`；`read` 被拒；日志无 `EADDRINUSE` |
| PS-1 | `ps1-integrity-off-session.jsonl` | lg-integrity 未激活（缺 `workspace`） | 一直 `not-verified`；`read` 被拒；`lg_integrity_check` 工具不存在 |
| PS-2 | `negatives-session.jsonl`（正面）、`sc3-negative-session.jsonl`（负面） | 干净检查后暂停解除；暂停期间只有 `lg_integrity_check` 可用 | PASS；单元测试 `pause lifecycle (PS-2)` 另覆盖解除与保持 |
| RL-1 | `rl1-session.jsonl` | 金丝雀布在 `~/.agents/`、workspace、`drafts/sub/` | 标记 `LG-CANARY-RL1-7f3a` **0 次**出现；角色文件内容 2 次出现 |
| RL-2 | `rl2-session.jsonl` | 临时移走 `LG-ROLE.md` | `FAIL role-file: … ENOENT`；`read` 被拒 |
| SC-1 | `negatives-session.jsonl` | `read` 绝对路径（Local 工作目录） | `read path escapes the Global workspace: …/调研-全局与局部Agent框架.md` |
| SC-2 | `negatives-session.jsonl` | `../outside/secret.txt`、`escape-link/secret.txt` | 两次均 `read path escapes the Global workspace` |
| SC-3 | `sc3-negative-session.jsonl`、`sc3-control-session.jsonl` | 会话 cwd 在 workspace 外 / 内 | 负面：`paused: session-cwd — …/outside is outside …/workspace`；对照 PASS 且同批操作成功 |
| SC-4 | `negatives-session.jsonl` | `write not-drafts.txt` | `write may only write inside …/drafts: not-drafts.txt` |
| SC-5 | `negatives-session.jsonl` | `http://127.0.0.1/`、`file:///etc/passwd`、`http://example.com/` | 三条均被拒，各自命中 allowlist / scheme 规则 |
| SC-6 | `sc6-session.jsonl` | `127.0.0.1.nip.io`、`lvh.me` **加进白名单** | 仍拒：`resolved 127.0.0.1.nip.io to a private address: 127.0.0.1`；对照公网域名 HTTP 200 |
| SC-7 | `sc7-session.jsonl`、`sc7-control-session.jsonl` | 测试插件 prepend 的 `pre-execute` 直接返回 `allow` | 负面：`no network verdict for this call`（fail-closed）；对照：同一目标按 allowlist 被拒、公网目标成功 |
| SC-8 | `test.txt`（`scope.test.ts`） | 单元测试 | PASS：pre-execute 之后改写 url 的调用按无判定拒绝 |
| RP-1 | `rp1-session.jsonl`、`rl1-session.jsonl` | 模型调 `lg_repo_log` / `lg_repo_show` / `lg_repo_sync` | 返回真实提交与原文件；`mirror 2a93a3795dd4 / remote 2a93a3795dd4 (equal)` |
| RP-2 | `rp2-integration.txt` | 真实 git + 真实文件系统 | `after tamper: … (moved)` → `after sync 2: … (reverted to upstream)` |
| RP-3 | `test.txt`（`repo.test.ts`） | 单元测试 | PASS：ssh／`git@`／`file://`／带用户名或令牌的 https 全部拒绝 |
| RP-4 | `test.txt`（`repo.test.ts`） | 单元测试 | PASS：git 环境无 `HOME`（指向不存在目录）、无 `SSH_AUTH_SOCK`、`GIT_CONFIG_GLOBAL=/dev/null` |
| RP-5 | `rp5-session.jsonl` | 往镜像配置塞 `http.extraheader` | `PAUSED: mirror-config`；`lg_repo_sync` 与 `read` 均被拒 |
| RP-6 | `rp6-probe.txt` | 本机实测探针 + 可写测试仓库对照 | `verdict: denied`；对照 `verdict: writable \| branch: pause \| paused: true` |
| IN-1 | `in1-session.jsonl` | preset 内多一个白名单外工具（`tool-jobs`） | **首次**工具调用即被拒：`paused: tool-whitelist — not allowed: job_output, job_list, job_kill` |
| IN-2 | `in2-session.jsonl`、`in2-isolation-report.md`、`in2-in3-channel-log.txt` | 启动自检经频道内部接口发报告，不经过模型 | 频道出现 `0001 global ISOLATION_REPORT`，`probes` 逐项与 `lg_integrity_check` 一致 |
| IN-3 | `in3-session.jsonl`、`in3-isolation-report.md` | 篡改已存档的 global 消息 | `FAIL sent-copies: … archived bytes differ from the saved copy (copy 866B, archive 880B)`；并自动发出 `0002 global ISOLATION_REPORT` |
| CH-12 | `in3-session.jsonl`、`test.txt`（`channel-runtime.test.ts`） | 同上 + 单元测试 | PASS：副本逐字节保存，篡改即报 |

## QA 对照

| 编号 | 做法 | 结果 |
| --- | --- | --- |
| QA-1 | `pnpm install`、`pnpm -r build`、`pnpm -r test` | `test.txt`：install 0 个 `WARN`/`ERR_`，**115 个用例全过** |
| QA-2 | 本里程碑每个需求编号在索引里有行 | 见上表 |
| QA-3 | 每项负面都有目标规则的报错原文 + 对照 | 上表逐条列出原文；对照见 SC-3/SC-6/SC-7/RP-6 与 `negatives-control-session.jsonl` |
| QA-4 | 会话验收证据是 `lg_evidence_session` 的原始事件 | 见"证据导出口径"；暂停中的会话例外并已标注 |
| QA-5 | 证据绑定验收时 HEAD | 见下方"绑定" |
| QA-6 | 无密钥、token、公网部署地址 | `secret-scan.txt` |
| QA-7 | 所用 dsh 接口有源码引用 | `dsh-interfaces.md` |

## 绑定

- 本文件提交时的 HEAD（验收时 HEAD）见频道 `0061` 的 REPORT `commit` 字段，即本文件所在提交。
- 会话证据的 sha256 全表在 `sc3-sha256.txt`。

## 两处此前未实现、本轮补齐的实现项

| 项 | 说明 |
| --- | --- |
| RP-5 | SPEC 要求核对镜像自己的 git 配置；实现里原本完全没有，本轮补 `foreignMirrorKeys()` |
| IN-2 | SPEC 要求启动自检经频道内部接口发 `ISOLATION_REPORT`；`ISOLATION_REPORT` 原本在 lg-global 里一次都没出现过，本轮补 `ChannelRuntime.reportIsolation()` |

## 一处已知的配置默认值偏差（未改）

SPEC 的配置表写 `stateDir` 默认 `$DSH_HOME/lg/state/<仓库标识>`，实现里是 `$DSH_HOME/lg`。本轮没动它——改默认值会让已绑定会话的游标搬家（需要重新 `/lg-bind`），我把这条留给 M3 一起处理，先在此登记，不假装它已经符合规格。
