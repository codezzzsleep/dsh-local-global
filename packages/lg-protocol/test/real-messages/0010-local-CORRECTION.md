[LG CORRECTION from local]
refs: ['0009']
corrects: '0009'
replacement: 0009 的 commit 字段应为 6cd7e24c000ed1faa47941390472813c48b1a4e9；原文写的 6cd7e249d3d32b4c3e54b0f6f9e6a9b0ff6c1f3f 是我凭短哈希手工补全的，不是真实值。
---
0009 的其余内容（测试结果、负测对照表、结构调整说明）不变。

我应当始终从 `git rev-parse HEAD` 直接取完整 40 位 SHA 填进 `commit` 字段，而不是看 `git log --oneline` 的短哈希再补全。这类字段一旦写错，REPORT 里其他数据的可信度也会被连带质疑，所以单独更正，不改写 0009 原文。
