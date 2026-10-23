# dsh-local-global

Local–Global 双 agent 框架的 DeepSeek Harness（dsh `0.2.1-rc.2`）插件实现。

- **Local**：在完整环境里执行，是代码和证据唯一的写者。
- **Global**：在隔离沙箱里审核，没有 shell，只有它能发 STOP，而且必须引用验收标准和真实环境证据。
- **Human**：HALT 优先于一切。

开发依据是 [`docs/spec.md`](docs/spec.md)（SPEC v2）。它与 `docs/design.md`、`docs/implementation.md`、`redesign/` 冲突时，以 SPEC 为准。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `packages/lg-protocol` | 普通库：消息解析、校验、渲染、取号、折叠状态（只认有效消息） |
| `packages/dsh-lg-common` | bundle：`lg-channel`（git 频道）、`lg-commands`、`lg_evidence_session` |
| `packages/dsh-lg-global` | bundle：preset `lg-global`、`lg-role`、`lg-scope`、`lg-repo`、`lg-integrity`、`lg-directive`、`lg-checkpoint` |
| `packages/dsh-lg-local` | bundle：`lg-evidence`、`lg-patch-apply`、`lg-report-gate`、`lg-action-gate`、`lg-protect` |
| `docs/` | `spec.md`（依据）、`channel-git.md`（频道契约）、两份早于 SPEC 的设计稿 |
| `evidence/` | 各里程碑的验收证据（见下文“证据状态”） |
| `redesign/` | 未采纳的提案，见下文 |

## 构建与测试

需要 Node 24 和 pnpm 11。

```sh
pnpm install
pnpm -r typecheck   # 从源码解析兄弟包，不需要先构建
pnpm -r test        # vitest；测试用固定的 git 身份，不依赖本机配置
pnpm -r build       # 生成 packages/*/lib，dsh plugin add 需要它
```

CI（`.github/workflows/ci.yml`）在每个 PR 上依次运行 typecheck、test、build。

## 安装

在构建好的工作区里，用 `dsh plugin add` 按本地路径安装。仓库地址、角色、工作区路径写在使用者自己的 profile 补丁里，不写进 bundle。

```sh
# Local：日常 profile
dsh plugin --profile lg-local add ./packages/dsh-lg-common ./packages/dsh-lg-local

# Global：独立的 DSH_HOME，profile 名以 lg-global 开头
export DSH_HOME=~/.lg-global/home
dsh plugin --profile lg-global add ./packages/dsh-lg-common ./packages/dsh-lg-global
```

配置字段和启动步骤见 `docs/implementation.md` 的“启动”一节，频道配置见 `docs/channel-git.md`。按形态 A/B/C 分别给出的完整安装说明属于 M7 的交付物，还没有写。

## 当前状态

| 里程碑 | 状态 |
| --- | --- |
| M1 频道与协议 | 曾经验收；本分支改了投递、HALT、取号和校验，验收证据需要重跑 |
| M2 Global 沙箱 | 实现完成，补齐了隔离漏洞；未验收 |
| M3 协议补充与 Local 侧 | 实现完成，补齐了审批、证据和补丁的漏洞；未验收。`evidence/M3/README.md` 写了“通过”，但 SPEC 的状态表仍写着“未开始” |
| M4 Global 写出口与检查点 | 已实现，有单元测试和集成测试；没有真实会话证据 |
| M5 仓库沙箱、M6 共察模式、M7 最终验收 | 未开始 |

## 证据状态

SPEC 规定，代码在证据产生之后变了，受影响的证据必须重跑。本分支改动了全部四个包，所以 `evidence/M1`～`evidence/M3` 里的会话证据都绑定在旧代码上，需要在真实的 dsh `0.2.1-rc.2` 会话里重跑。另外：

- `evidence/M3/ev-real` 和 `ev-leaky` 的 manifest 用的是旧 digest（HEAD 哈希）。按新的定义（代码树，不含证据目录），它们会显示为 stale。
- `evidence/M2/README.md` 声称 RP-4、SC-8 有单测，当时并没有；本分支补上了这两组测试。
- 早期提交的历史里留有 4 个 dsh web 访问令牌（只绑定 127.0.0.1，后来的提交已经打码），建议轮换。

## 已知限制

- 隔离停留在规则层：Global 与 Local 用不同的 `DSH_HOME`，但不要求独立系统用户或容器（SPEC 硬约束 4）。守卫和工具执行之间仍有检查与使用之间的时间窗（TOCTOU）。
- Local 侧对 shell 文本的匹配只防误操作和自发越界，不防刻意绕过（SPEC PT-1 / lg-action-gate）。审批账本放在 Local 自己的状态目录里。
- 在 Global 侧，`lg-integrity` 的配置哈希首次运行时记录基线（trust on first use），之后变化由 Human 确认。
- 本分支没有在真实 dsh 进程里运行过。插件接口按已安装的 dsh 源码和 `evidence/` 里真实机器的 `--dump-config` 编写。

## redesign/

`redesign/` 是最新一次提交加入的另一套设计（通信沙箱、代码库沙箱、Global 沙箱）。它取消了 Global 的 STOP 权和 Human 的 HALT，也不再以 dsh 插件交付，与 SPEC 冲突，所以目前只作参考，不进 CI。已知问题：

- `git http-backend` 提前退出时会抛出未处理的 EPIPE，进程整个崩溃。
- 通信沙箱的 4xx 拒绝会被当成“已排队”，之后静默丢弃。
- 服务器用户的 `~/.gitconfig` 里如果设置了 `core.hooksPath`，可以绕过分支限制。
- 没有真正的 Local agent 或 dsh 插件，模型适配器只在 stub 下测试过。

要不要采纳、删除或继续，由 Human 决定。
