# M1 验收证据索引

对应 DIRECTIVE 0005 的 AC-1 至 AC-5。所有证据都在本目录，文件名与下表一致。

## 环境

| 项 | 值 |
|---|---|
| dsh | `0.2.1-rc.2` |
| node | `v24.22.0` |
| pnpm | `11.28.5` |
| OS | Ubuntu 24.04.4 LTS (Noble Numbat), kernel 6.8.0-136-generic, x86_64 |
| 模型 | `deepseek-flash`（provider `deepseek-account`） |
| 环境类型 | **real** —— 本机真实 dsh 进程，真实 git 仓库，真实会话；无模拟件 |

## AC-1 补丁应用

| 项 | 内容 |
|---|---|
| 证据 | `evidence/M1/P1-apply-patch.txt` |
| 命令 | `git am --3way attachments/0004/docs-channel-contract.patch` |
| 结果 | PASS。三个文件 sha256 与 0004 声明逐项一致（`diff` 输出 `IDENTICAL`） |
| 应用后 commit | `2bbb0ff3b38b1f09ffbcb482832e2cf7b36aa1e3` |
| 环境 | real |

说明：AC-1 原含“提交作者保持为 Global”，该条已按 Human 的直接要求作废（详见频道 0008）。补丁来源以 0004 为准，文件内容未变。

## AC-2 测试

| 项 | 内容 |
|---|---|
| 证据 | `evidence/M1/test.txt` |
| 命令 | `pnpm install` 然后 `pnpm -r test` |
| 结果 | PASS。65 个用例全过（lg-protocol 60 + dsh-lg-common 5），0 失败，安装输出无错误无警告 |
| 环境 | real |

`test.txt` 开头是完整的 `pnpm install` 输出，末尾是把 0005“测试要求”七条负测逐条指到具体用例的对照表，另加真实 git 并发写入的集成测试。

## AC-3 安装与卸载

| 项 | 内容 |
|---|---|
| 证据 | `evidence/M1/dump-config-before-install.txt`、`dump-config-after-install.txt`、`dump-config-after-remove.txt` |
| 命令 | `dsh plugin --profile lg-m1 add ./packages/dsh-lg-common` / `... remove @local-global/dsh-lg-common` / `dsh --profile lg-m1 --dump-config` |
| 结果 | PASS。装前 1229 行且无 `lg-` 行；装后 1239 行，末两条为 `lg-channel`、`lg-commands`；卸后回到 1229 行，与装前 `diff` 完全相同 |
| 环境 | real |

## AC-4 端到端 E1–E8

| 项 | 内容 |
|---|---|
| 证据 | `evidence/M1/e2e.md`（逐项结论）、`e2e-evidence.jsonl`（每步原始记录）、`e2e-channel-log.txt`（测试频道提交日志与消息原文） |
| 命令 | `LG_E2E_PHASE=1 dsh --profile lg-m1` 然后 `LG_E2E_PHASE=2 dsh --profile lg-m1`（两次进程，用于验证 E5 重启） |
| 结果 | PASS，E1–E8 八项全过，无超时 |
| 环境 | real（测试频道 `/tmp/lg-m1-channel.git`，bare） |

**这里有一处与 0005 不同，必须记录**：0005 要求在 Web 界面里人工新建会话并执行 `/lg-bind`，这台机器没有可自动化的浏览器，所以 E2E 驱动在 dsh 进程内用 `ctx.agents.create()`、`ctx.commands.execute()`、`ctx.tools.execute()` 完成同样的调用——这三个正是 Web 适配器内部使用的公开接口。被验证的是真实的 dsh 进程、profile、插件、命令与工具管线，只有“由谁触发”不同。若 Global 要求必须有人工点击网页的记录，需要另跑一轮 Playwright。

## AC-5 本文件

`evidence/M1/README.md` 即本文件，逐项列出 AC-1 至 AC-4 的证据文件、执行命令、环境（real / simulated）与结果。

## 从零复现

```sh
pnpm install
pnpm -r build          # 生成 packages/*/lib，dsh plugin add 需要它
pnpm -r test           # 期望 65 passed
git init --bare --initial-branch=main /tmp/lg-m1-channel.git
dsh --profile lg-m1 --from-default-profile web
dsh plugin --profile lg-m1 add ./packages/dsh-lg-common
dsh --profile lg-m1 --dump-config | tail -12
```
