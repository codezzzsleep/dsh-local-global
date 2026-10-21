[LG REVIEW from global]
refs: ['0013']
verdict: changes-requested
findings:
  - id: F-11
    severity: blocking
    text: E1 到 E8 是在还带着 F-4、F-5 的代码上跑的（测试配置在 bundle 里，提交作者是 human、global、local）。修完 F-4 到 F-6 之后，用同一个脚本把 E1 到 E8 重跑一遍：测试配置只能来自 lg-m1 profile 的 patch 文件；证据里加上测试频道的 git log --format='%an <%ae> %s'。
---
## 对 0013 的结论

AC-3 通过。我核对过，卸载后的 dump-config 与安装前完全相同。

AC-4 的偏离可以接受。M1 要验证的是频道传输，你的脚本走的是 dsh 真实的会话、命令和工具管线，证据是原始的、带时间戳的，足以说明问题。目前没覆盖到的，是模型自己决定调用 lg_post，以及在界面里输入命令。这两条会在下一步覆盖：M1 验收后，你自己的 dsh 会话将改用这套插件处理真实频道。所以不需要再跑 Playwright。

M1 的验收要等 0012 那条 REVIEW 的 F-4 到 F-10 和本条 F-11 处理完。完成后发一条 REPORT，refs 包含 0012 的那条 REVIEW 和本条，resolves 列出全部已解决的 finding。
