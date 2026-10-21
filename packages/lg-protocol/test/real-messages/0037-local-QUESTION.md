[LG QUESTION from local]
options:
  - 1 接受 inconclusive 即暂停
  - 2 允许 file:// 镜像并实测 push 失败
  - 3 允许 SSH + 只读 deploy key
  - 4 降级为配置断言，探针只作辅助
blocking: true
default_action: 继续做与 push 探针无关的 AC-3 场景，push 一项保持未完成
commit: 2dd1d1d49197253c0a31fbcf70cdac2c97b98eee
directive_version: 3
refs:
  - "0035"
---
## 实现按批准的文档改完了，但 push 探针卡在一个环境事实上

仓库 commit `2dd1d1d`。改动：`lg-role` 新插件；网络拒绝落到同步守卫并按 `{callId,url,verdict}` 校验；路径按会话工作目录解析、无 path 的 glob/grep 以 cwd 为目标；`lgState` 暂停；注册表断言；git 环境白名单化；探针用临时仓库且不依赖镜像 HEAD；每次 git 调用加超时。

已实测（不是声明）：

```text
N1 读 Local 目录 → lg-scope: read path escapes the Global workspace: …/调研-…
P1 读 workspace  → ok
P5 完整性检查    → PASS
N8 加白名单外工具后 → lg-global paused: tool-whitelist — not allowed: probe_extra_tool
                    → 之后 P6/P7/P8/P9 全部被拒（同一暂停理由）
```

暂停这次是真的拦住了后续每一次调用。

## 问题：匿名 https 的 push 探针只能得到 inconclusive

同一环境下 `git ls-remote https://…` 秒回，但 `git push --dry-run https://…` 挂住，60 秒超时才被杀。看起来到 GitHub 的 git-http POST 被网络层挡住。

| 配置 | 结论 |
|---|---|
| 默认 SSH key | `writable`（正确报警） |
| 只读 deploy key | `denied`（干净） |
| 匿名 https（你要求的路径） | `inconclusive`（超时） |

按 F-5，`inconclusive` 会让 Global 暂停，所以现在 M2 一启动就停在 `push-probe`。fail-closed 是对的，但 AC-3 的 push 一项拿不到 `denied`。

四个选项：

1. 接受 `inconclusive` 即暂停（M2 在本机永远暂停，我认为不满足 AC-3）
2. 允许 `file://` 镜像，探针改测本地 bare 仓库的 push
3. 允许 SSH + 只读 deploy key（本机唯一能稳定得到 `denied` 的路径，但与 F-6 冲突）
4. 降级为配置断言（remote 必须是 https + 无写凭据），探针只作辅助

默认动作：在你回答前，我继续做与 push 无关的 AC-3 场景（相对路径、无 path 的 glob、prepend 绕过、cwd 越界、私有地址、N10 换端口），push 一项保持未完成，不自行选 2/3/4。
