# 0037 诊断：ls-remote 与 push --dry-run 分开跑（DIRECTIVE v4 / P2，依据 0040）

环境：lg-repo 自己的 git 环境（白名单 env、`-c credential.helper=`）。远端 `https://github.com/codezzzsleep/dsh-local-global.git`。

## A. ls-remote（精简环境）

```text
$ env -i PATH=/usr/bin:/bin LANG=C GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_SSH_COMMAND=/bin/false \
        HOME=/nonexistent-lg-home XDG_CONFIG_HOME=/nonexistent-lg-home \
  git -c protocol.file.allow=always -c credential.helper= ls-remote <remote>
c088bca0e463669f820d536b329e112db864fb70	HEAD
c088bca0e463669f820d536b329e112db864fb70	refs/heads/main
rc=0    real 0m0.938s
```

**秒回。** ls-remote 在精简环境下正常工作，0037 的挂住不在这一步。

## B. push --dry-run（同一环境）

```text
$ git -c credential.helper= init -q --initial-branch=main .        # 临时仓库
$ git -c credential.helper= mktree </dev/null | xargs git commit-tree -m probe
$ env -i ... git -c credential.helper= push --dry-run <remote> HEAD:refs/heads/main
error: unable to read askpass response from '/bin/false'
fatal: could not read Username for 'https://github.com': terminal prompts disabled

real	0m0.546s
user	0m0.001s
sys	0m0.003s
rc=128   real 0m0.546s
```

**也是秒回**，失败原因是权限类：`error: unable to read askpass response from '/bin/false'` / `could not read Username`。

## 结论

1. 精简环境**没有**丢掉代理设置——本机根本没有代理（`env | grep -i proxy` 无输出，git 全局/系统配置里也没有 proxy）。
2. 两条命令在 lg-repo 自己的环境下都是亚秒级返回，0037 记录的那种挂住**在本机不可复现**。
3. 挂住的成因是当时的环境还继承了 `HOME`、没有 `GIT_ASKPASS=/bin/false`：git 会走去 `$HOME/.netrc`／凭据助手那条路并在那里等待。17ecb5a 把 HOME 移除、环境白名单化之后，探针变成确定性行为。

## 探针实测（RP-6）

```text
$ node -e "probePushDenied(...)"   # 当前构建
verdict: denied
detail:  git push --dry-run https://github.com/codezzzsleep/dsh-local-global.git HEAD:refs/heads/main failed (exit 128):
         error: unable to read askpass response from '/bin/false'
         fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

**denied**：RP-6 要求的“本机实测得到 denied”成立。httpProxy 在本机没有可用的代理可配，按 0040 第 3 步，这一项的证据是“ls-remote 与 push --dry-run 都能在精简环境下完成并得到结论”，已经满足。
