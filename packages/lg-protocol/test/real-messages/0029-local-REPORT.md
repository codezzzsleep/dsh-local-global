[LG REPORT from local]
commit: 8949861cd20b5b5fa84ef8b32b007e69dfce88b2
directive_version: 3
evidence:
  - evidence/M2/README.md
  - evidence/M2/acceptance-raw.json
  - evidence/M2/acceptance-run.log
  - evidence/M2/push-probe.md
  - evidence/M2/tamper-reset.txt
  - evidence/M2/negative-preset-override.log
  - evidence/M2/negative-profile-name.log
  - evidence/M2/probes.md
negative_tests:
  - N1 读 Local 工作目录被拒
  - N2 ../ 逃逸被拒
  - N3 符号链接逃逸被拒
  - N4-N7 web_fetch 四类目标被拒
  - N8 白名单外工具被完整性检查发现
  - N9 只读凭据下 push 被拒
  - N10 preset 被改回 standard 拒绝启动
  - N11 profile 名不符拒绝启动
refs:
  - "0027"
  - "0025"
---
## M2 完成：四部分实现 + 负面验收 + 对照

仓库 commit `8949861`，证据索引 `evidence/M2/README.md`。运行环境：profile `lg-global-m2`、独立 `DSH_HOME=~/.dsh-global-m2`、dsh `0.2.1-rc.2`。

## AC-3：七类负面全部按预期失败（报错原文都在 `acceptance-raw.json`）

```text
N1 读 Local 工作目录   → lg-scope: read path escapes the Global workspace: …/GlobalAndLocalAgent/调研-…
N2 ../ 逃逸            → lg-scope: read path escapes the Global workspace: …/outside/secret.txt
N3 符号链接逃逸        → lg-scope: read path escapes the Global workspace: …/workspace/escape-link/…
N4 127.0.0.1           → lg-scope: web_fetch host is not in the allowlist: 127.0.0.1
N5 192.168.1.10        → lg-scope: web_fetch host is not in the allowlist: 192.168.1.10
N6 file://             → lg-scope: web_fetch only allows http and https, got file:
N7 example.com         → lg-scope: web_fetch host is not in the allowlist: example.com
N8 白名单外工具        → FAIL tool-whitelist: not allowed: probe_extra_tool
N10 preset 改回 standard → lg-integrity: refusing to work — defaultId=standard expected=lg-global
N11 profile 名不符      → lg-integrity: this profile is named "m2-wrong", but lg-global may only run in a profile starting with "lg-global"
```

N9（push）单独一份 `evidence/M2/push-probe.md`：

- 用本机默认 SSH key 对真实远端 `git push --dry-run` → `writable`（探针报错，正是要抓的情况）。
- 用只读 deploy key → `denied`，原文 `ERROR: The key you are authenticating with has been marked as read only.`

这也是 F-1 的落实：探针打真实远端，判据是**失败原因**，地址不可达一律判 `inconclusive`，不算通过。

## AC-4：每项都有对照

P1 读 `LG-ROLE.md` 成功、P2 相对路径成功、P3 内部符号链接成功、P4 `https://api.github.com/rate_limit` HTTP 200、P5 组合正常时完整性检查 `PASS`。N9 的对照就是换回可写 key 后探针变 `writable`——失败来自权限，不是功能坏了。

## AC-5：仓库四项 + 篡改恢复

`lg_repo_sync` 返回 `mirror 787f1908c68a / remote 787f1908c68a (equal)`；`log`/`show`/`diff` 都对真实插件仓库工作。把镜像 `refs/heads/main` 手工改到 `478bd09`，调 `lg_repo_sync` 后回到 `787f190`（`tamper-reset.txt`）。

## AC-6

`pnpm -r test`：91 个用例全过（lg-protocol 61、dsh-lg-global 19、dsh-lg-common 11），0 失败。

## 实现过程中必须记下的两处接口事实

1. **preset 的工具不在 `agent.ctx.tools` 里**。preset 的行装在独立的 isolate 组里，普通 `agent.ctx` 解析到 host realm；要在 `create` 的 `setup` 回调里 `agentPresets.mount(agentCtx, 'lg-global')` 才绑上，枚举会话真实工具要 `agentPresets.acquireScope(id)` 拿 `ScopeKey` 再 `ctx.tools.schemas(key)`。`lg-integrity` 的白名单检查就用的这条路径——否则它只能看到 host 级工具，`bash` 加进来也发现不了。
2. **凭据隔离是部署问题，不是代码问题**。这台机器上默认 SSH key 对插件仓库有写权限，探针如实报 `writable`。M2 的解法是给镜像配一个只读 deploy key（`sshKeyPath` 配置，`core.sshCommand` 注入），探针随即变 `denied`。文档里“只读凭据”那句因此有了可执行的落地方式。

## 仍未覆盖

`lg-directive`、`lg-checkpoint` 属 M4，本次未做；`environment: real` 的可验证性按你的决定留到 M3。
