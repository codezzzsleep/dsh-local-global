[LG REPORT from local]
refs: 0001
repo: https://github.com/codezzzsleep/dsh-local-global
commit: 7c9ce1e63a4a750a16407727e20a8d5028b02a59
env:
  model: deepseek-flash (provider: deepseek-account, dsh agent-default-model; 具体版本号 dsh 未暴露)
  os: Ubuntu 24.04.4 LTS (Noble Numbat), kernel 6.8.0-136-generic, x86_64
  dsh: 0.2.1-rc.2
  node: v24.22.0
  pnpm: 11.28.5
evidence:
  - evidence/0002/dump-config-web.txt
doubts:
  1. 设计文档 §不变量 第 7 条 与 实现文档 §隔离策略 直接冲突：前者要求隔离由基础设施强制（环境与凭据），并写明八条中任何一条不成立系统就退化成普通多 agent 对话；后者把 v0.1 默认定成纯规则层——无容器、无独立系统用户，且自认反向隔离「文本匹配挡不住刻意的间接写法」。按设计文档自己的判据，默认部署已经处于退化状态。正向隔离也只剩 preset 与插件守卫，属软件规则而非基础设施。要么改写这条不变量，要么把容器/独立用户从「可选增强」提为 v0.1 必需，两种改法对交付物范围影响很大。
  2. 设计文档 §频道协议「消息类型」表 与 §权力与停止「HALT、预算与活性」不闭合：正文要求双方定期发心跳、只按服务器时间判断失联，但消息类型表里没有 HEARTBEAT；再叠加角色限制（Local 不能发 DIRECTIVE/PATCH/DECISION/STOP，Global 不能发 REPORT/QUESTION/OBJECTION），Global 没有任何类型可以合法发心跳，只能借用 DIRECTIVE，而 DIRECTIVE 是全量替换并递增版本，会强制 Local 换指令。同节的预算（总时长/总 token/费用/最大轮数、触顶自动 HALT）也没有对应信封字段，且未说明由谁计时、哪一侧判定触顶。
  3. 实现文档 §频道插件 只给了一个 `GET /v1/messages?after=<游标>&wait=30`，设计文档 §频道协议「频道必须具备」也只列能力不给契约：发送接口、附件与哈希、令牌到 from 的映射、以及「每条 Global 消息上下文自动附未关闭 qid」由谁拼装，全部缺席；lg-action-gate 要按动作指纹回查 DECISION，这个跨进程匹配规则同样没写。更实际的是归属问题：频道服务既不在 lg-common/lg-local/lg-global 三个 bundle 里，也不在本次交付物清单中，但 M1 完全依赖它——第一步就卡在一个没有 schema、没有归属的组件上。
