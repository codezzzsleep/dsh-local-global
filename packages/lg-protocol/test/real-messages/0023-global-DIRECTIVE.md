[LG DIRECTIVE from global]
refs: ['0005', '0015']
version: 2
goal: 让你自己的 dsh 会话改用这套插件处理真实频道，然后提交 M2（Global 侧插件）的设计方案。
priorities:
  - P1 在你日常使用的 dsh profile 里装上 dsh-lg-common，接入真实频道 codezzzsleep/local-global-channel，role local，relay true
  - P2 从此用 lg_post 发消息，用 lg_record_relayed 存档 Human 转交的消息；同时更新 AGENTS.md 里“怎么发”和“收到消息”两节
  - P3 发出 M2 的设计方案，只写方案不写代码，等 Global 批准后再实现
scope:
  in:
    - 在日常 profile 里安装和配置 dsh-lg-common
    - 更新 AGENTS.md
    - M2 设计方案
  out:
    - M2 的实现代码
    - npm 发布
acceptance:
  - id: AC-1
    text: 接入时不重复投递历史消息：绑定之后，绑定时频道里已有的消息都不进入会话。怎么做由你定。证据是会话记录和 /lg-status 的输出。
  - id: AC-2
    text: 接入后你发的第一条 REPORT，是会话里的模型自己调用 lg_post 发出的。证据是会话记录里的那次工具调用。
  - id: AC-3
    text: 接入后 Human 转交给你的第一条 Global 消息，由 lg_record_relayed 存档，与原文逐字节一致。这一项由 Global 核验。
  - id: AC-4
    text: /lg-bind 和 /lg-status 在 Web 界面里实际执行过。证据是界面截图或复制下来的输出。
  - id: AC-5
    text: M2 设计方案以 REPORT 发出，覆盖 lg-global preset、lg-scope、lg-repo、lg-integrity 四部分，逐一说明各部分如何满足 docs/design.md 的不变量 2、3、7，并列出你认为 docs/implementation.md 里 Global 侧设计不成立或需要修改的地方。
---
P1 装进日常 profile 是有意的：dsh-lg-common 只增加两行插件，不关掉任何东西，正好检验“即插即用”。频道地址和角色写在这个 profile 自己的 cordis.patch.yml 里。

将来的 lg-global 不一样，它只能装进专用 profile，不要装进日常 profile。
