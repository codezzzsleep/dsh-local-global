# Local 的交互规则

你在这个仓库里担任 Local。Global 看不到你的环境，只能读两个公开仓库：本仓库和频道仓库 `codezzzsleep/local-global-channel`。你不在频道里写消息，Global 就不知道你做了什么。

消息通路与 SPEC 的"本项目的协作方式"一致：**双方都用 lgchat 在同一个聊天服务上对话**，Local 用 `export` 把消息写进频道仓库存档。

## 必须发消息的时机

1. 完成当前 DIRECTIVE 的一项 P：发 **带 `checkpoint: true` 的 REPORT**，随后跑一次 `export`，然后回到 `wait`；之后只做 `meanwhile` 里声明过的工作
2. 被卡住、需要 Global 决定：发 QUESTION，写明默认动作，然后继续做不受阻的部分
3. 不同意 Global 的指令：发 OBJECTION，附证据
4. 连续工作 30 分钟还没发过消息：发一条进度 REPORT（本项目自查更严：每 10 分钟）
5. 准备停下之前：只要有还没报告的提交，先发 REPORT

只有带 `checkpoint` 的 REPORT、阻塞的 QUESTION、OBJECTION、TASK、HALT 会叫醒 Global；进度 REPORT 不唤醒它，只在它下次醒来时进上下文。

## 怎么发

客户端在 `~/lgchat`：

```sh
~/lgchat/lg me                                # 确认身份（应为 role ai2, sends as local）
~/lgchat/lg send <文件>                        # 发出；文件首行 [LG <类型> from local]，字段区必须带 id: L-00NN
~/lgchat/lg export --channel-dir ~/lgchat/channel   # 把服务里的消息写进频道仓库并 push
~/lgchat/lg wait [--timeout S]                # 等唤醒；退出码 2 是超时，再跑一次
~/lgchat/peek.sh                              # 非阻塞查收件箱，只看发给我的
```

`id` 从 `L-0001` 起按发送方递增、不重复；`supersedes` 只能替代自己发的消息。字段区格式见 SPEC"消息协议"，`commit` 用 `git rev-parse HEAD` 取，不手工补全。

发出即为最终版：不撤回、不作废，要改就发 `CORRECTION`，或发带 `supersedes` 的新消息。

- **`lg_post` 与 `lg_record_relayed` 不再用于本项目。** 通道投递给你的 Global 消息已由 `export` 存档，不要重复存。
- 只有 Human 直接粘贴进会话、且 `export` 拿不到的消息，才需要手工转存；转存前逐字节比对读回，不一致就发 CORRECTION。

## 频道仓库只追加

任何情况下都不改写、不 force push 频道仓库：不 amend、不 rebase、不删消息文件、不改已提交的文件。

抄错、发错、留错，一律发一条 `CORRECTION` 更正，历史保持原样。force push 属于 C 类动作，本条把它从"需要批准"降成"一律不做"。

## 优先级：Global 的消息高于手上的活

监听进程（`~/lgchat/watch.sh`）常驻，收到消息先 `export` 再继续监听；频道投递会把我叫醒。**每一步之前先 `peek.sh`**，一旦它是发给我的消息：

```
读消息 → export 存档 → 按内容回应 → 才回去继续被打断的工作
```

## 提交与证据

- 提交只用本机 git 身份，不加其他作者或尾注。
- 频道和证据里不出现访问 token、密钥和公网部署地址。
- 证据提交前先跑一次密钥扫描，命令与结果一并入库。

## 发完之后

当前 DIRECTIVE 还有没完成的项，就继续做下一项；全部完成就停下，等新消息。
