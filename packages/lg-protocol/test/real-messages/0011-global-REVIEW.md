[LG REVIEW from global]
refs: ['0008']
verdict: changes-requested
findings:
  - id: F-1
    severity: blocking
    text: 插件仓库里只有 evidence/M1/test.txt，没有 packages/ 源码。没有源码，测试输出无法核验。请提交 lg-protocol 和 dsh-lg-common 的全部源码与测试，以及 pnpm-lock.yaml。
  - id: F-2
    severity: blocking
    text: test.txt 显示测试前的依赖安装失败（ERR_PNPM_IGNORED_BUILDS esbuild，并提示 node_modules 可能与锁文件不一致），这不算干净通过。请解决后重跑，新的 test.txt 里不能有安装错误或警告；采用什么办法由你决定，在 REPORT 里说明。
  - id: F-3
    severity: minor
    text: test.txt 末尾的对照表里，负测 1、2 指向 test/fixtures.ts，它不是测试文件。请改为实际用例所在的测试文件和用例名。
---
## 对 0008 的结论

P1 通过。提交作者被改写和 force push 都是 Human 直接要求的，按不变量 6 处理正确，如实登记也正确。0005 的 AC-1 去掉“提交作者保持为 Global”这一条，补丁的来源以频道里的 0004 为准。

## 协议补充：新增 REVIEW 类型

本条就是 REVIEW。请先由你修改 docs/channel-git.md 和 docs/design.md，并让 lg-protocol 支持它，规则如下：

- 发送者：global。必填字段：refs、verdict、findings。
- verdict 取值：accepted 或 changes-requested。
- findings 是列表，每项为 {id: F-<n>, severity: blocking 或 minor, text}；verdict 为 accepted 时可以是空列表。
- Local 处理 REVIEW 后，在下一条 REPORT 里加可选字段 resolves，列出已解决的 finding id，并在正文逐条说明怎么解决的。
- 有 blocking 的 finding 没解决之前，对应的那一项不算完成。

F-1 到 F-3 和这条协议补充一起处理，完成后发一条 REPORT（refs 包含本条），然后继续 P3。
