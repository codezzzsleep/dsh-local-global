# P1：SPEC v2 存为 docs/spec.md（F-1 后重做）

来源：Human 2026-10-21 交付的附件 `Local-Global-SPEC-v2.md`。
本文件在 0043 REVIEW 的 F-1 之后重做：上一版是 SPEC 的旧修订版（c3fba7ab，59033 字节）。

```text
$ sha256sum "<附件>" docs/spec.md
0b39ffcb17d609a8cf50c40b693cd2e1c477b2295d17caf6fb47088a163ee940  /var/lib/deepseek-harness/.dsh/attachments/v1/files/0b/0b39ffcb17d609a8cf50c40b693cd2e1c477b2295d17caf6fb47088a163ee940/Local-Global-SPEC-v2.md
0b39ffcb17d609a8cf50c40b693cd2e1c477b2295d17caf6fb47088a163ee940  docs/spec.md

$ wc -c "<附件>" docs/spec.md
 59542 /var/lib/deepseek-harness/.dsh/attachments/v1/files/0b/0b39ffcb17d609a8cf50c40b693cd2e1c477b2295d17caf6fb47088a163ee940/Local-Global-SPEC-v2.md
 59542 docs/spec.md
119084 total

$ cmp "<附件>" docs/spec.md && echo BYTE-IDENTICAL
BYTE-IDENTICAL
```

新版 sha256 `0b39ffcb17d609a8cf50c40b693cd2e1c477b2295d17caf6fb47088a163ee940`，59542 字节；两份相同，`cmp` 无差异。

## 与上一版的实际差异

`diff` 显示只有一处实质改动，正是 Global 指出的那一节（第 640 行起）：

```diff
  1c1
  < 本项目的两个模型通过 Human 部署的 webchat 自动通信，不再由 Human 转贴。Global 用 lgchat.py 在 webchat 里收发；Local 不直接碰 webchat，仍然只用频道仓库。两边之间由桥接程序 lgbridge.py 自动同步，GitHub 上的频道仓库始终是正式存档。
  ---
  > Global 和 Local 都通过 lgchat 客户端，在同一个聊天服务上对话，不再由 Human 转贴。聊天服务是一项抽象的通用能力：部署在哪里都行，只要提供下面的接口。Human 给双方各发一个地址、一个 token 和 lgchat.py 即可。
```

旧版写的是 lgbridge 桥接（Local 不直接碰 webchat）；新版是双方都用 lgchat、Local 用 `export` 写频道仓库。仓库现在与 Human 交付的最新修订版一致。

## 旧文档的标注

```text
# 兼顾全局和局部的 Agent 框架：以 DeepSeek Harness 为例

> **本文件早于 SPEC v2。** 项目规格是 [`docs/spec.md`](spec.md)；凡本文件与 `docs/spec.md` 冲突之处，一律以 `docs/spec.md` 为准。
...
# Local–Global 实现文档：基于 DeepSeek Harness

> **本文件早于 SPEC v2。** 项目规格是 [`docs/spec.md`](spec.md)；凡本文件与 `docs/spec.md` 冲突之处，一律以 `docs/spec.md` 为准。
```
