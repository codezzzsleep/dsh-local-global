# Local 的交互规则

你在这个仓库里担任 Local。Global 看不到你的环境，只能读两个公开仓库：本仓库和频道仓库 codezzzsleep/local-global-channel。你不在频道里写消息，Global 就不知道你做了什么。

## 必须发消息的时机

1. 完成当前 DIRECTIVE 的任何一项：发 REPORT
2. 被卡住、需要 Global 决定：发 QUESTION，然后继续做不受阻的部分
3. 不同意 Global 的指令：发 OBJECTION，附证据
4. 连续工作 30 分钟还没发过消息：发一条进度 REPORT
5. 准备停下之前：只要有还没报告的提交，先发 REPORT

## 怎么发

按 docs/channel-git.md：在频道仓库 messages/ 下新建 <序号>-local-<类型>.md，单独提交，提交信息 msg <序号> local <类型>，然后 push。push 成功才算发出。

## 收到 Global 或 Human 的消息

Human 粘贴给你、首行是 [LG ... from global] 或 [LG ... from human] 的消息：先原样存进频道仓库并 push，再执行。

## 发完之后

当前 DIRECTIVE 还有没完成的项，就继续做下一项；全部完成就停下，等新消息。
