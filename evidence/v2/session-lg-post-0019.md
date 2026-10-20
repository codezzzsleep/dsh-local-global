# AC-2 证据：会话记录里的那次 lg_post 调用

来源：本机真实会话 `session-51cfb27a-442a-4aad-a510-a037f8b226eb` 的日志
`~/.dsh/sessions/--var-lib-deepseek-harness-GlobalAndLocalAgent--/session-51cfb27a-442a-4aad-a510-a037f8b226eb/session.v4.jsonl.zstd`，
用 `zstd -d` 解压后按 `seq` 取出两条原始事件，**未做任何编辑**，原样存放于 `session-lg-post-0019.jsonl`（2 行，sha256 `6742afde1ee54f0ffdcbf16d36a3e8ad6cd4647d756fc9901c08958a4d6a5dcb`）。

## 1. 模型发起的工具调用

事件 `tool/call`，`seq: 2660`，`turn: 18`，`step: 5`，`name: lg_post`。
`arguments` 是模型输出的原始 JSON 字符串（不是插件补全的）：

```json
{
  "type": "REPORT",
  "refs": ["0005", "0015", "0018"],
  "fields": {
    "commit": "bd8ef5fa92067f90a1bb29170182e7e6ae70e599",
    "directive_version": 2,
    "evidence": ["evidence/v2/lg-status.txt", "evidence/v2/dump-config-web.txt", "evidence/M1/test.txt", "AGENTS.md"],
    "negative_tests": ["AC-1：首次绑定把游标设为频道最大序号，0001–0018 全部未进入会话", "bind 后换会话重绑保留游标，既不重放也不丢（channel-runtime.test.ts › bind）"],
    "resolves": ["0014/F-4", "0014/F-5", "0014/F-6", "0014/F-7", "0014/F-8", "0014/F-9", "0014/F-10", "0016/F-11", "0018/F-12"]
  }
}
```

（上面为便于阅读只摘了字段结构；完整原文含 `body`，见 jsonl 第一行。）

## 2. 工具返回

事件 `tool/result`，`seq: 2661`，`isError: false`，`sourceEventSeqs: [2660]`：

```text
posted 0019-local-REPORT.md as 97c81d84b0d0
```

## 3. 交叉核对

| 项 | 值 |
|---|---|
| 会话记录的返回 | `posted 0019-local-REPORT.md as 97c81d84b0d0` |
| 频道仓库里 0019 的真实 commit | `97c81d84b0d0477d1befc4e5c5fad5ba9e5d8be7` |
| 二者关系 | 返回值的 12 位前缀与真实 commit 前 12 位一致 |

频道侧可用 `git show 97c81d84b0d0477d1befc4e5c5fad5ba9e5d8be7` 复核，提交标题为 `msg 0019 local REPORT`。
