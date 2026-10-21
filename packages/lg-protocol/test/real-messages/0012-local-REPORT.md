[LG REPORT from local]
refs: ['0011']
commit: f86f2d18f4ea5f535cba22a2f8b8c0234111d022
directive_version: 1
evidence:
  - evidence/M1/test.txt
  - packages/lg-protocol/test/parse.test.ts
  - packages/lg-protocol/src/validate.ts
negative_tests: []
resolves: ['F-1', 'F-2', 'F-3']
---
## F-1（blocking）源码已入库

`packages/` 下的全部源码与测试、根配置文件、`pnpm-lock.yaml` 都已提交：

```text
afeeb9d feat: add lg-protocol and dsh-lg-common sources with tests
f86f2d1 docs: add REVIEW type; record clean M1 test run
```

仓库现在 40 个跟踪文件，含 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`，以及两个包各有 `src/`、`test/`、`package.json`、`tsconfig.json`。`lib/` 与 `node_modules/` 按 `.gitignore` 不入库——克隆后需要 `pnpm install && pnpm -r build` 才能 `dsh plugin add`，这条我会写进 `evidence/M1/README.md`。

## F-2（blocking）安装警告已消除

根因不是“装不上”，而是 **pnpm 11 改了配置键名**：`onlyBuiltDependencies`（pnpm 10 的写法）在这个版本里不生效，实际读的是 `allowBuilds`，而且值是映射而不是列表。我先按旧写法配了一遍，`pnpm config get onlyBuiltDependencies` 能读到值却依旧报 `ERR_PNPM_IGNORED_BUILDS`；翻 pnpm 自身的 `ignoredBuilds.js` 与 `assertValidAllowBuilds` 才确认键名。现在 `pnpm-workspace.yaml` 里是：

```yaml
allowBuilds:
  esbuild: true
```

效果：`pnpm install` 会正常执行 `esbuild postinstall`，输出里不再有 `ERR_PNPM_IGNORED_BUILDS`，也不再有 “node_modules may be out of sync” 的提示；`node_modules/.modules.yaml` 的 `ignoredBuilds` 里也不再有 esbuild。新的 `evidence/M1/test.txt` 开头就是完整的 `pnpm install` 输出，可以直接对照确认没有错误或警告。

## F-3（minor）对照表已改到真实用例

`test/fixtures.ts` 现在只导出夹具，不含任何用例；parse 的用例移到新文件 `packages/lg-protocol/test/parse.test.ts`。新 test.txt 的对照表逐个指到“文件 › describe › 用例名”。

顺带发现一个此前被掩盖的问题：`fixtures.ts` 被三个测试文件 import，里面那 6 个 parse 用例被重复收集了三次，旧 test.txt 里 `format.test.ts (12 tests)`、`validate.test.ts (30 tests)` 这些偏大的数字就是这么来的。拆开后每个用例只跑一次，真实总数是 **65**（lg-protocol 60 + dsh-lg-common 5），比旧的 68 少 3 不是丢了用例，而是去掉了重复计数。

## REVIEW 协议已落地

- `docs/channel-git.md` §4：表格新增 `REVIEW | global | refs、verdict、findings`，字段约定新增一条说明 verdict 取值、findings 结构、REPORT 的 `resolves`，以及“blocking 未解决则对应工作项不算完成”。
- `docs/design.md` 消息类型表：新增 REVIEW 一行，发送者 Global。
- `lg-protocol`：`MESSAGE_TYPES` 增 `REVIEW`，发送者限 global，必填 `refs`/`verdict`/`findings`；校验 verdict ∈ {accepted, changes-requested}、findings 每项 `{id: F-<n>, severity: blocking|minor, text}`、accepted 时允许空列表；REPORT 新增可选字段 `resolves`（`F-<n>` 列表）；`foldState` 新增 `unresolvedFindings`，按 REVIEW 的 findings 减去所有 REPORT 的 resolves 折叠，未解决的 blocking 项因此可被程序化读出。
- 新增 8 个用例覆盖：local 发 REVIEW 被拒、非法 verdict、非法 finding id、非法 severity、accepted 空 findings 合法、resolves 形状、以及 fold 的“未解决/已解决”两态。

## 下一步

继续 P3：把 lg-channel/lg-commands 的 AC-3 三份 `--dump-config` 补齐，然后进 P4 的 E1–E8。
