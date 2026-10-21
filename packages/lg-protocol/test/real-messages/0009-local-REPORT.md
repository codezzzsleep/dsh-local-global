[LG REPORT from local]
refs: ['0005']
commit: 6cd7e249d3d32b4c3e54b0f6f9e6a9b0ff6c1f3f
directive_version: 1
evidence:
  - evidence/M1/test.txt
  - evidence/M1/P1-apply-patch.txt
negative_tests: []
---
## P2 完成：lg-protocol 与单元测试

`pnpm -r test` 全部通过：**68 个用例，0 失败**（lg-protocol 63 + dsh-lg-common 5），原始输出见 `evidence/M1/test.txt`。

```text
lg-protocol     4 files, 63 tests passed
dsh-lg-common   1 file,   5 tests passed
```

0005“测试要求”七条负测逐条落实，对照表写在 `evidence/M1/test.txt` 末尾：

| # | 要求 | 用例数 |
|---|---|---|
| 1 | 首行格式错误被拒 | 1 |
| 2 | 文件名与首行发送者/类型不一致被拒 | 2 |
| 3 | 每种类型缺必填字段被拒 | 12（12 个类型各一） |
| 4 | local 发 DIRECTIVE、global 发 REPORT 被拒 | 2（外加 global 发 TASK、CLAIM 双向合法） |
| 5 | 序号跳号/重复被识别 | 3 |
| 6 | DECISION 回答后 QUESTION 不再未关闭 | 2 |
| 7 | consumed_approvals 后批准不可再用 | 3 |

外加真实 git 集成测试：两个独立克隆同时向同一 bare 仓库 push，后 push 的一方重新取号并成功，远端最终为 `0001`、`0002` 连续不重复（`test/git-channel.test.ts`，5 个用例）。

## 按 0007 授权做的一处结构调整

0007 把“lg-protocol 要提供的接口”一节降为建议，我据此调整了两处，理由如下：

1. **把格式渲染的共享类型抽到 `src/format-types.ts`**，避免 `format.ts` 与 `parse.ts` 互相引用造成循环依赖；对外导出不变，仍是 `formatMessage`。
2. **`findSeqAnomalies` 新增为独立导出**（原“接口”一节只列了 `nextSeq`）。第 5 条负测要求“跳号或重复被识别”，`nextSeq` 只负责取下一个号，无法表达“识别”，所以拆出一个纯函数承担识别，测试也直接打它。

其余接口名与签名与 0005 一致：`parseMessage`、`validateMessage`、`formatMessage`、`nextSeq`、`foldState`、`actionFingerprint`。

## 下一步

P3 已完成绝大部分（dsh-lg-common 的 lg-channel 与 lg-commands 已能装进 profile lg-m1 并被 dsh 加载）。正在收尾 AC-3 的三份 `--dump-config` 与 P4 的 E1–E8；E1 已在真实 dsh 上通过（0002 在 10 秒内投递到绑定会话，标签 `[LG #0002 DIRECTIVE v1 from global]`），E2 遇到 `ctx.tools.execute` 的参数形态问题，正在修。
