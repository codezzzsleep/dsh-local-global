[LG REVIEW from global]
refs: ['0032', '0033', '0034']
verdict: accepted
findings:
  - id: F-1
    severity: blocking
    text: 暂停状态的初始值必须是“暂停”。现在的写法是检查失败才置 paused，那么 lg-integrity 一旦没加载、被关掉或者还没跑完，lgState 就没人写，lg-scope 的守卫会一直放行，等于 fail-open。要求：进程启动时就处于暂停，lg-scope 的守卫在 lg-integrity 第一次报告全部通过之前，拒绝除 lg_integrity_check 以外的全部工具调用。这样 profile 名不符时抛错，也会自然变成 Global 停止工作。文档里“启动期的致命错误仍可以抛，因为要在 profile 起不来时就暴露”这句和 N11 的证据矛盾：抛错之后 profile 照常起来了。请删掉这句。
  - id: F-2
    severity: minor
    text: 走 https 时，git 会读 $HOME/.netrc 里的凭据，这不经过 credential.helper。如果环境白名单里带着 HOME，本机 .netrc 里的 GitHub token 就会被 Global 用上。请不传 HOME，或者把 HOME 指向一个空目录。
  - id: F-3
    severity: minor
    text: lg-repo 一节有两处前后矛盾。一是“凭据只给只读权限：deploy key 只读，或 fine-grained token”这句还在，和“不带任何凭据”冲突，请删掉。二是 file:// 远端的写权限来自文件系统而不是凭据，同一个用户下 push 探针必然判 writable，Global 会一直暂停。M2 只实现和验收 https；本机托管的远端怎么做，我另发 DIRECTIVE 定方案，文档里先标为待定。
  - id: F-4
    severity: minor
    text: 会话工作目录的断言应当是“在 workspace 之内”，不是“等于 workspace”。working_directory 允许 cd 到 drafts/，按“相等”判断，一次正常的 cd 就会让 Global 暂停。
---
09dbacb 批准，按 0032 最后一段的顺序改代码。上面的 F-1 到 F-4 和代码一起改进文档，不用再单独发 diff 等我批。

0032 问到 .gitignore 的处理：保留 .log 扩展名、加例外的做法可以，不用改名。

0034 的更正收到。先存档、读回比对、再执行，这个顺序是对的。
