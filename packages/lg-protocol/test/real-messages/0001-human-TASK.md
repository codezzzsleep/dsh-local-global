[LG TASK from human]

目标：做一套 DeepSeek Harness 插件，实现 Local–Global 框架。附件是两份文档：设计文档（协议与规则）和实现文档（插件方案）。

硬约束：
- 不 fork、不修改 DeepSeek Harness 的任何代码，只使用它公开的插件接口。
- 交付物是可以用 dsh plugin add 安装、用 dsh plugin remove 卸载的 npm 包（bundle）。

本步骤只做准备工作，严格按以下规定执行，不要增减：

一、插件仓库
- 名称：codezzzsleep/dsh-local-global，公开，默认分支 main
- 许可证：MIT
- GitHub topics：dsh-plugin
- 本步骤只提交这些文件：
    README.md                 只写一行：Local–Global framework as DeepSeek Harness plugins.
    LICENSE                   MIT 全文，版权人 codezzzsleep
    .gitignore                Node 项目的标准忽略规则（node_modules/、dist/、*.log）
    docs/design.md            设计文档附件，内容原样，只改文件名
    docs/implementation.md    实现文档附件，内容原样，只改文件名
    evidence/0002/dump-config-web.txt
                              dsh --profile web --dump-config 的完整输出
                              提交前检查一遍，确认里面没有 API key 或 token；有就替换成 <REDACTED>
- 提交信息：docs: add design and implementation specs
- 不要创建 packages/ 或任何代码，那是下一步的事

二、频道仓库 codezzzsleep/local-global-channel
- 消息文件放在 messages/ 下，文件名格式：<四位序号>-<发送者>-<类型>.md，例如 0002-local-REPORT.md
- 发送者只用 human、global、local；类型用大写
- 编码 UTF-8，换行 LF
- 每条消息单独一个提交，提交信息：msg <四位序号> <发送者> <类型>
- 本步骤提交两条：
    messages/0001-human-TASK.md     这条 TASK 原样
    messages/0002-local-REPORT.md   你的第一条 REPORT，格式见下

三、REPORT 格式（0002 必须照此填写，字段不能少）

[LG REPORT from local]
refs: 0001
repo: https://github.com/codezzzsleep/dsh-local-global
commit: <插件仓库这次提交的完整 40 位 SHA>
env:
  model: <你的模型名和版本>
  os: <操作系统和版本>
  dsh: <dsh --version 的输出>
  node: <node --version 的输出>
  pnpm: <pnpm --version 的输出>
evidence:
  - evidence/0002/dump-config-web.txt
doubts:
  1. <读完两份文档后，你认为最不清楚或最可能不成立的一处，写明在哪份文档的哪一节>
  2. <同上>
  3. <同上>

做完就停下，等 Global 的 DIRECTIVE。
