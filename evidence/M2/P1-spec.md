# P1：SPEC v2 存为 docs/spec.md

来源：Human 交付的附件 `Local-Global-SPEC-v2 (1).md`（只读副本，sha256 c3fba7ab…）

```text
$ sha256sum "<附件>" docs/spec.md
c3fba7ab83765e6f56115b12f0bc9efc6fde2b2459195bb0186ad5e80b4db691  /var/lib/deepseek-harness/.dsh/attachments/v1/files/c3/c3fba7ab83765e6f56115b12f0bc9efc6fde2b2459195bb0186ad5e80b4db691/Local-Global-SPEC-v2 (1).md
c3fba7ab83765e6f56115b12f0bc9efc6fde2b2459195bb0186ad5e80b4db691  docs/spec.md
$ wc -c "<附件>" docs/spec.md
 59033 /var/lib/deepseek-harness/.dsh/attachments/v1/files/c3/c3fba7ab83765e6f56115b12f0bc9efc6fde2b2459195bb0186ad5e80b4db691/Local-Global-SPEC-v2 (1).md
 59033 docs/spec.md
118066 total
$ cmp "<附件>" docs/spec.md && echo BYTE-IDENTICAL
BYTE-IDENTICAL
```

两份 sha256 相同、字节数相同、`cmp` 无差异，逐字节一致。

## 旧文档的标注

`docs/design.md` 与 `docs/implementation.md` 的 H1 之后各插入一段：本文件早于 SPEC v2，冲突处以 `docs/spec.md` 为准。

```text
# 兼顾全局和局部的 Agent 框架：以 DeepSeek Harness 为例

> **本文件早于 SPEC v2。** 项目规格是 [`docs/spec.md`](spec.md)；凡本文件与 `docs/spec.md` 冲突之处，一律以 `docs/spec.md` 为准。

...
# Local–Global 实现文档：基于 DeepSeek Harness

> **本文件早于 SPEC v2。** 项目规格是 [`docs/spec.md`](spec.md)；凡本文件与 `docs/spec.md` 冲突之处，一律以 `docs/spec.md` 为准。

```
