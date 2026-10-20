# push 探针的两种结论

探针 `probePushDenied()`（`packages/dsh-lg-global/src/repo.ts`）对**真实远端地址**执行
`git push --dry-run <remote> HEAD:refs/heads/main`，再按失败原因分类，而不是只看“是否失败”。

## 1. 环境里存在可写凭据（本机默认 SSH key）

```text
$ git clone --depth 1 git@github.com:codezzzsleep/dsh-local-global.git /tmp/pushprobe2
$ probePushDenied({ remote: "git@github.com:...", mirrorDir: "/tmp/pushprobe2" })
{
  "verdict": "writable",
  "exitCode": 0,
  "detail": "Everything up-to-date"
}
```

→ `writable`。探针抓到“环境里有写凭据”，这正是它存在的意义：Global 的 profile 里不能出现这种凭据。

## 2. M2 profile 实际使用的只读 deploy key

`git -C <mirror> config core.sshCommand 'ssh -i ~/.dsh-global-m2/keys/repo-readonly -o IdentitiesOnly=yes'`

```text
{
  "verdict": "denied",
  "exitCode": null,
  "detail": "git push --dry-run git@github.com:codezzzsleep/dsh-local-global.git HEAD:refs/heads/main failed (exit 128): ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists."
}
```

→ `denied`。失败原因是“key 被标记为只读”，属于权限类，探针才算通过；地址不可达等其他原因会被判为 `inconclusive`。
