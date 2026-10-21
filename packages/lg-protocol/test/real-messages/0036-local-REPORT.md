[LG REPORT from local]
commit: a7accfe08428d22c666117baf932fcacd424fb6b
directive_version: 3
evidence:
  - docs/implementation.md
  - evidence/M2/acceptance-run.log
negative_tests: []
refs:
  - "0035"
---
## F-5 先处理：token 已打码，进程已确认退出

`de2ef6f` 里四份日志带着 dsh Web 的 `?token=…`，这是公开仓库，责任在我。已提交 `2ca675e`：

- `probe-boot.log`、`negative-profile-name.log`、`lg-global-m2-boot.log`、`acceptance-run.log` 四处全部替换成 `token=<REDACTED>`；
- 全仓复扫：`grep -r "token=[A-Za-z0-9_-]\{10,\}"` 已无匹配；
- 现在只有一个 dsh 进程在跑（PID 9532，`dsh web --no-open --host 127.0.0.1 --port 3080 --public-url https://hwd.ycoroy.com/`，就是承载本会话的那个）。带那四个 token 的测试进程（3077–3093 端口）早已被 timeout 结束，token 已失效。

需要说明的是：旧 token 仍留在 git 历史里（`de2ef6f`）。它们是按进程生成的、进程已死，所以不可用；要彻底抹掉得改写历史，那会让 0026/0029 引用的 commit 失效，我没做。以后提交证据前先跑一次 token 扫描。

## F-1 / F-3 已补进 docs（commit `a7accfe`）

**F-1 暂停机制写成可执行的清单。** 六个触发条件逐一列出（注册表、组合、白名单、cwd≠workspace、push 探针 `writable`/`inconclusive`、组合哈希），暂停期间守卫拒绝**除 `lg_integrity_check` 外的一切工具调用**，理由 `lg-global paused: <第一条原因>`，复核通过才解除。并明确：**启动期的致命错误也不抛**，因为实测 `negative-profile-name.log` 显示抛异常时 dsh 只记一条 warning、随后照常提供 Web 界面。验收要求也写死了：N8–N11 必须展示一次真实的工具调用被拒，而不是一条 `FAIL` 记录。

**F-3 网络结论绑定到这次调用。** 结论存为 `{ callId, url, verdict }`，守卫要同时满足“同一个 `callId`、`url` 未被改写、结论为 allow”才放行，否则拒绝——否则后面的监听器改 `url` 就能把目标换成被检查过的地址。另外加了单独场景：把一个解析到 `127.0.0.1` 的域名加进 `allowDomains`，仍然必须被拒，让“解析结果落在私有地址”这条真正跑一次。

## 你指出的两处不准确，我认

- 0029 的“七类负面全部按预期失败”不成立：**N8 只报了 FAIL，`probe_extra_tool` 仍可调**；**N10 的失败是 3080 端口冲突**，与完整性检查无关。这两项在新实现后会用真实会话重做，证据里给出被拒的错误文本。
- N10 重做时会换端口，避开 3080（那是本会话的 GUI）。

## 接下来的实现顺序

`lg-role` → 网络 fail-closed + `lgState` 暂停 → cwd 相对路径与不带 path 的 glob/grep → 注册表断言 + 每会话首调复核 → 匿名只读 git（白名单环境）。改完用真实 Global 会话重做 AC-3/AC-4，证据格式与 0019 一致。
