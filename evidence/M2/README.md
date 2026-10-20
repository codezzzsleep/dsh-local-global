# M2 验收证据索引

对应 DIRECTIVE v3（频道 `0025`）的 AC-1 至 AC-6。环境：dsh `0.2.1-rc.2`、node `v24.22.0`、pnpm `11.28.5`、
profile `lg-global-m2`、独立 `DSH_HOME=/var/lib/deepseek-harness/.dsh-global-m2`。除特别注明外全部是 **real**。

## AC-1 DIRECTIVE v2 AC-2 补齐（会话记录）

| 项 | 内容 |
|---|---|
| 证据 | `evidence/v2/session-lg-post-0019.jsonl`、`evidence/v2/session-lg-post-0019.md` |
| 命令 | `zstd -d` 解压 `session-51cfb27a…/session.v4.jsonl.zstd`，取 `seq` 2660 与 2661 |
| 结果 | PASS。`tool/call` 有 `callId`、`turn: 18`、`step: 5`、`name: lg_post`；`tool/result` 返回 `posted 0019-local-REPORT.md as 97c81d84b0d0`，与频道 0019 的真实 commit `97c81d84b0d0477…` 一致 |

## AC-2 四个接口的探针

| 项 | 内容 |
|---|---|
| 证据 | `evidence/M2/probes.md`、`probe-raw.json`、`probe-boot.log` |
| 命令 | 探针插件装进 `lg-global-m2` 后启动一次 |
| 结果 | PASS。四个接口都给出源文件路径与实测行为，并记录两处与方案不符（`selectedDefault` 覆盖、`inspectCompositions` 启动时为空） |

## AC-3 负面验收

原始结果 `evidence/M2/acceptance-raw.json`（逐项含 `id/kind/expectation/isError/detail`），运行日志 `acceptance-run.log`。

| 编号 | 操作 | 期望 | 实测报错原文 |
|---|---|---|---|
| N1 | 读 Local 工作目录 | 拒绝 | `lg-scope: read path escapes the Global workspace: …/GlobalAndLocalAgent/调研-全局与局部Agent框架.md` |
| N2 | `../` 逃逸 | 拒绝 | `lg-scope: read path escapes the Global workspace: …/.dsh-global-m2/outside/secret.txt` |
| N3 | 符号链接逃逸 | 拒绝 | `lg-scope: read path escapes the Global workspace: …/workspace/escape-link/secret.txt` |
| N4 | `web_fetch` 127.0.0.1 | 拒绝 | `lg-scope: web_fetch host is not in the allowlist: 127.0.0.1` |
| N5 | `web_fetch` 局域网 | 拒绝 | `lg-scope: web_fetch host is not in the allowlist: 192.168.1.10` |
| N6 | `web_fetch` file:// | 拒绝 | `lg-scope: web_fetch only allows http and https, got file:` |
| N7 | `web_fetch` 名单外域名 | 拒绝 | `lg-scope: web_fetch host is not in the allowlist: example.com` |
| N8 | 会话出现白名单外工具 | 完整性检查失败 | `FAIL tool-whitelist: not allowed: probe_extra_tool` |
| N9 | 任何途径 push | 必须失败且是权限原因 | `push-probe.md`：只读 key → `denied`（`ERROR: The key you are authenticating with has been marked as read only.`）；默认可写 key → `writable`，探针报错 |
| N10 | 用户 patch 把默认 preset 改回 standard | 拒绝启动 | `negative-preset-override.log`：`lg-integrity: refusing to work — defaultId=standard expected=lg-global` |
| N11 | 装进名称不以 lg-global 开头的 profile | 拒绝启动 | `negative-profile-name.log`：`lg-integrity: this profile is named "m2-wrong", but lg-global may only run in a profile starting with "lg-global"` |

## AC-4 每项负面对照

| 对照 | 操作 | 实测 |
|---|---|---|
| P1 | 读 workspace 内文件 | 成功，返回 `LG-ROLE.md` 内容 |
| P2 | workspace 内相对路径 | 成功 |
| P3 | workspace 内符号链接 | 成功 |
| P4 | `web_fetch` 名单内域名 | 成功，`https://api.github.com/rate_limit` HTTP 200 |
| P5 | 组合正常时的完整性检查 | `PASS` |
| N9 的对照 | 同一探针换回可写 key | `writable`——失败确实来自凭据权限，不是探针坏了 |

## AC-5 仓库正面验收

| 编号 | 工具 | 实测 |
|---|---|---|
| P6 | `lg_repo_sync` | `mirror 787f1908c68a / remote 787f1908c68a (equal)` |
| P7 | `lg_repo_log` | 列出 `787f1908… feat: lg-global bundle with preset, scope, repo, and integrity` |
| P8 | `lg_repo_show` | `README.md` 内容原样返回 |
| P9 | `lg_repo_diff` | `HEAD~1..HEAD` 的 diff 正常 |

篡改恢复（`tamper-reset.txt`）：把镜像 `refs/heads/main` 手工指到 `HEAD~1`（`478bd09`），调用 `lg_repo_sync` 后
镜像回到 `787f190`，与远端一致。

## AC-6 测试与索引

| 项 | 内容 |
|---|---|
| 命令 | `pnpm -r test` |
| 结果 | PASS。91 个用例：lg-protocol 61、dsh-lg-global 19、dsh-lg-common 11，0 失败 |
| 环境 | real |

## 复现

```sh
export DSH_HOME=/var/lib/deepseek-harness/.dsh-global-m2
dsh plugin --profile lg-global-m2 add ./packages/dsh-lg-global
dsh plugin --profile lg-global-m2 add ./packages/dsh-lg-global/probe
dsh --profile lg-global-m2 --port 3077
# 结果写在 /tmp/m2/acceptance.json
```

`lg-global-m2` 的 profile 覆盖层见 `lg-global-m2-cordis.patch.yml`：`workspace`、`remote`、`sshKeyPath` 都在那里，
bundle 本身不含任何环境配置。
