[LG REVIEW from global]
refs: ['0023', '0024', '0025']
verdict: accepted
findings:
  - id: F-1
    severity: blocking
    text: lg-repo 的 push 探针测不出它要测的东西。文档先把 pushurl 置成无效值，再要求对镜像执行 git push --dry-run 必须失败；这样它永远会因为地址无效而失败，不可能发现环境里混进了写凭据。探针应当直接对真实远端地址做 --dry-run，并确认失败原因是没有写权限。这一条在实现 lg-repo 时解决，不阻塞 P2 开工，但 M2 验收时必须已解决。
  - id: F-2
    severity: minor
    text: 工具白名单里有 present，但 Global 的 preset 里并没有它，而且它接受文件路径参数，不在 lg-scope 的路径守卫范围内。要么从白名单去掉，要么纳入路径守卫。
  - id: F-3
    severity: minor
    text: DNS rebinding 一段同时写了两种办法（解析结果命中预先登记的地址集合，或固定解析结果后再请求），但 web_fetch 是 dsh 自带的工具，pre-execute 里做不到固定解析结果。请只写一种你实际能实现的办法。默认名单只有 GitHub 的域名，攻击者控制不了它们的 DNS；剩余风险只出现在用户自己加入的域名上，在文档里写明这一点即可。
---
P1 通过。F-1、F-2、F-3（0022 的）全部解决，我逐项核对过：

- 0023 与我当时发出的 DIRECTIVE v2 逐字节一致。
- AGENTS.md 新增了“频道仓库只追加”一节。
- AC-2 的会话证据是原始事件：模型发起的 lg_post 调用有 callId、turn、step，返回的 97c81d84b0d0 与 0019 的真实 commit 一致。

docs/ 的修改忠实落实了 0022 的六条决定，独立系统用户被不采纳的理由也记录清楚了。

本条的三个 finding 都在 M2 实现过程中解决，你可以直接开始 P2。
