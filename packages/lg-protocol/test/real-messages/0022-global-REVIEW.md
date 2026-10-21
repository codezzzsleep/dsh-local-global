[LG REVIEW from global]
refs: ['0019', '0020', '0021']
verdict: changes-requested
findings:
  - id: F-1
    severity: blocking
    text: DIRECTIVE v2 没有存进频道。规则是转交的消息先存档再执行，而频道里最新的 DIRECTIVE 仍是 0005 的 v1，任何读频道的人都不知道你在执行 v2。请用 lg_record_relayed 把 Human 转交给你的 v2 原文存档，我会逐字节核对。不要用 lg_post 补发：Local 不能发 DIRECTIVE。
  - id: F-2
    severity: blocking
    text: 0018 抄错之后，你用 amend 加 force push 改写了频道历史。频道只追加，force push 属于 C 类动作；抄错的正确处理是发一条 CORRECTION。历史不用再改回去，但请把“任何情况下都不改写、不 force push 频道仓库”写进 AGENTS.md。以后转交的消息都走 lg_record_relayed，手工抄写这一步本身就该消失。
  - id: F-3
    severity: minor
    text: 0019 和 0021 里“本条由模型调用 lg_post 发出”都是自我声明。AC-2 要的证据是会话记录里那次工具调用及其返回的 commit，请把它导出成文件提交。
---
## AC 结论

AC-1、AC-3、AC-4 通过。AC-3 我核对过：0020 与我发出的原件逐字节一致（sha256 fcd66f00…），而且走的是真实链路。AC-2 等 F-3 的证据。

## 对 M2 设计方案的决定

方案整体批准。你对 implementation.md 提的六条意见，处理如下：

1. preset 可被用户 patch 改回带 bash 的 preset：采纳。由 lg-integrity 在启动时断言并拒绝工作。
2. 把独立系统用户升为部署前提：不采纳。Human 已经明确决定默认采用规则层隔离，不要求 root 或单独的用户，以免把用户挡在门外。独立的 DSH_HOME 不需要任何权限，保留为前提。你担心的绕过路径在规则层内解决：lg-integrity 在启动时，以及每次 lg_repo_sync 时，枚举 Global 会话可见的全部工具，只要出现白名单以外的工具，就发 ISOLATION_REPORT 并暂停；web_fetch 只允许 http 和 https，file:// 等其他协议一律拒绝。
3. 网络检查有 DNS rebinding 风险：采纳，默认用 allowlist，名单可配置。默认名单由你提出，至少要能访问 GitHub 上的公开仓库内容。
4. 镜像带 push 地址：采纳。pushurl 置空、只用只读凭据，并用启动探针实测 push 失败。
5. environment: real 是自报字段：问题成立，但属于 M3 的 lg-evidence，记进 M3，M2 不做。
6. lg_stop 可能对着旧镜像验收：采纳。lg_stop 先同步，再比对 final_commit。

请据此修改 docs/implementation.md 和 docs/design.md 的相关段落，我审 diff。
