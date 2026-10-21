[LG DIRECTIVE from global]
refs: ['0019', '0021']
version: 3
goal: 按 0019 的方案和本条之前那条 REVIEW 的决定，实现 M2：@local-global/dsh-lg-global，含 preset lg-global、lg-scope、lg-repo、lg-integrity 四部分。
priorities:
  - P1 处理上一条 REVIEW 的 F-1、F-2、F-3，并按其中的决定更新 docs/
  - P2 先写探针，确认 0.2.1-rc.2 中 agent-preset-registry、tools.guard、tools/pre-execute、agent-instructions 四个接口的真实形状，再写实现
  - P3 实现四部分，先做负面验收，再做正面验收
scope:
  in:
    - packages/dsh-lg-global
    - 为 M2 验收专门建的 profile lg-global-m2，使用独立的 DSH_HOME
    - docs/ 中与上一条 REVIEW 决定相关的修改
  out:
    - lg-local 的插件（M3）
    - lg-directive、lg-checkpoint（M4）
    - npm 发布
    - 把本项目的 Global 换成 dsh 进程（本项目的 Global 仍由我担任）
acceptance:
  - id: AC-1
    text: DIRECTIVE v2 的 AC-2 补齐：会话记录里能看到模型调用 lg_post 的那次工具调用及其返回的 commit。
  - id: AC-2
    text: 四个接口的探针结果作为证据提交，每个接口给出它在本机 node_modules 中的源文件路径。
  - id: AC-3
    text: 负面验收全部按预期失败，每项都有原始证据。至少包括：读 Local 的工作目录；用 ../ 和符号链接逃逸出工作区；web_fetch 访问 127.0.0.1、局域网地址、file:// 和名单外的域名；通过任何途径向仓库 push；会话里出现白名单以外的工具；用户 patch 把默认 preset 改回 standard；把 lg-global 装进名称不以 lg-global 开头的 profile。
  - id: AC-4
    text: 每一项负面验收都要配一个对照：同样的操作换成允许的目标就能成功，以证明失败来自守卫，而不是功能本身坏了。
  - id: AC-5
    text: 正面验收：在 lg-global-m2 里，lg_repo_sync、lg_repo_log、lg_repo_diff、lg_repo_show 对真实的插件仓库都能工作；同步后镜像 HEAD 等于远端 HEAD；手工改动镜像后再同步，改动被撤销。
  - id: AC-6
    text: pnpm -r test 干净通过；evidence/M2/README.md 逐项列出 AC-1 到 AC-5 的证据文件、命令、环境和结果。
---
负面验收比正面验收更重要：M2 的价值就在于该失败的一定失败。AC-3 每一项失败时的报错原文都要保留，我会逐条看。

每完成一个 P 就发一条 REPORT。遇到 0.2.1-rc.2 的接口和方案对不上，先发 QUESTION，不要自己绕过去。
