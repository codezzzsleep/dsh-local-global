[LG REPORT from local]
commit: 17ecb5a2d0ee2681a73d5074b7de39caf6edb83d
directive_version: 3
evidence:
  - docs/implementation.md
  - packages/dsh-lg-global/src/state.ts
  - packages/dsh-lg-global/src/repo.ts
negative_tests: []
refs:
  - "0038"
  - "0037"
---
## F-1 到 F-4 已改进代码与文档（commit `17ecb5a`）

**F-1 启动即暂停。** `lgState` 构造时带一条 `not-verified` 占位，`paused` 的判定改为 `!verified || reasons.length > 0`；只有 lg-integrity 第一次报告全部通过才 `markVerified()`。所以 lg-integrity 没加载、被关掉、或检查还没跑完，守卫都是拒绝——反过来写就是 fail-open。文档里那句“启动期的致命错误仍可以抛”已删掉，并写明理由：抛错之后 dsh 只记一条 warning、profile 照常起来，`negative-profile-name.log` 就是证据。

**F-2 不传 HOME。** `runGit` 的环境白名单只留 `PATH`、`LANG`，`HOME` 与 `XDG_CONFIG_HOME` 指向不存在的目录——git 读 `$HOME/.netrc` 这条路径不经过 `credential.helper`，白名单里带 HOME 等于把本机 token 交给 Global。

**F-3 只做 https。** 文档删掉“deploy key 只读 / fine-grained token”那句；`file://` 标为**待定**，并写明原因（写权限来自文件系统而非凭据，同一用户下 push 探针必然 `writable`）。代码里 `resolveRepoConfig` 现在直接拒绝非 `https://` 的远端。

**F-4 cwd 用“在 workspace 之内”。** 代码本来就是 `isInside`，文档改成“之内，不是相等”，并注明 `working_directory` 允许 `cd drafts/`，按相等判断会让一次正常 `cd` 触发暂停。

测试：`pnpm -r test` 98 个用例全过（lg-protocol 61、dsh-lg-global 26、dsh-lg-common 11）。

## 仍未解决：0037 的 QUESTION

0037 问的是 push 探针在匿名 https 下的行为，0038 没有涉及。现状：

- 匿名 https 的 `git push --dry-run` 在本机**挂住**，60 秒超时后被我们自己的超时杀掉 → `inconclusive`；
- 按 F-5 的规则 `inconclusive` 即暂停 → 现在 M2 启动后停在 `push-probe`，Global 永远不工作；
- 而 F-3 又要求 M2 只做 https。

所以这两条合起来会让 M2 在这台机器上无法通过验收。要么接受“inconclusive 即暂停”（等于 M2 不可用），要么允许另一条能稳定得到 `denied` 的路径（只读 deploy key 或 file://）。等你对 0037 的决定。

## 其余未重跑的项

AC-3 的相对路径、无 path 的 glob/grep、prepend 绕过、cwd 越界、私有地址解析、N8–N11 的真实会话证据，都要等 push 探针定案后一起做——否则一启动就暂停，所有场景都会被同一条 `paused` 理由盖住，测不出各自的行为。
