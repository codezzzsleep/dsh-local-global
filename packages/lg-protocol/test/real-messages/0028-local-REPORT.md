[LG REPORT from local]
commit: 787f1908c68aef2a98c8d951bf32f7db9b7fe3fa
directive_version: 3
evidence:
  - evidence/M2/lg-global-m2-boot.log
  - evidence/M2/lg-global-m2-cordis.patch.yml
  - evidence/M2/probes.md
negative_tests: []
refs:
  - "0027"
  - "0025"
---
## P3 进度：bundle 已能装、能起

`packages/dsh-lg-global`（commit `787f190`）四部分都在：

| 部分 | 文件 | 现状 |
|---|---|---|
| preset lg-global | `cordis.patch.yml` | 装 persona / agent-instructions（`LG-ROLE.md`，maxBytes 65536）/ tool-fs / tool-fs-search / tool-web；关掉 standard、cordis、ptc、minimal；registry default 指向 lg-global |
| lg-scope | `src/scope.ts` | 同步 guard 管路径（`realpath` 解析后必须落在 workspace，write/edit 另限 `drafts/`）；pre-execute 管 `web_fetch`（只允许 http/https、默认 allowlist、解析结果不得是私有地址） |
| lg-repo | `src/repo.ts` | bare 镜像 + 只读 plumbing；`lg_repo_sync/log/diff/show`；`pushurl` 置成无效值（纵深防御），**push 探针打真实远端** |
| lg-integrity | `src/integrity.ts` | 断言运行时 `defaultId`、profile 名前缀、按会话枚举工具白名单；`lg_integrity_check` 工具输出逐项结果 |

profile `lg-global-m2`（独立 `DSH_HOME=~/.dsh-global-m2`）已装并成功启动，日志在 `evidence/M2/lg-global-m2-boot.log`，profile 覆盖层在 `evidence/M2/lg-global-m2-cordis.patch.yml`。

## F-1 的落实方式

`probePushDenied()` 直接用**真实远端地址**跑 `git push --dry-run <remote> HEAD:refs/heads/main`，并且区分三种结论：

- 失败且信息含 `Permission denied` / `403` / `denied` / `read-only` / `authentication failed` → `denied`，通过。
- push 成功 → `writable`，记 error，拒绝服务读取。
- 因地址不可达 / URL 非法 / 仓库不存在而失败 → `inconclusive`，记警告，**不算通过**。

这正是你指出的“先置无效 pushurl 再测”的反面：那种写法只会得到 `inconclusive`。

## 已按 F-2、F-3 改的文档

- 白名单去掉 `present`，并写明理由（preset 不装它、它接受路径参数又不在路径守卫范围内）。
- DNS rebinding 一段只留一种能实现的办法：pre-execute 里解析域名 + 要求域名在名单内；明确写“固定解析结果做不到，因为 `web_fetch` 是 dsh 自带工具，拿不到它的 socket”；并写明剩余时间窗只对用户自己加入的域名成立，默认名单全是 GitHub 控制的域名。

## 下一步

写 M2 的验收驱动（`packages/dsh-lg-global/probe/` 扩成 acceptance harness），按 AC-3 逐条做负面验收并配 AC-4 的对照，然后 AC-5 的仓库四项。负面项每条都要留报错原文。

这一条是进度 REPORT，不是完成 REPORT：AC-3/AC-4/AC-5 还没有证据，我不会声称通过。
