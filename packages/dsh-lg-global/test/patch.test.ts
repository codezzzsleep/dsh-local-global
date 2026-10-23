import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../../dsh-lg-local/src/patch.js'
import { checkPath, resolveScopeConfig } from '../src/scope.js'
import { resolveDirectiveConfig } from '../src/directive.js'
import { createWorld, git, refusal, type World } from './m4-world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(async () => {
  await w.close()
})

const baseSha = async (): Promise<string> => await w.sync()
const edit = (path: string, text: string): void => {
  mkdirSync(join(w.drafts, path, '..'), { recursive: true })
  writeFileSync(join(w.drafts, path), text)
}
const channelMessages = async (): Promise<{ seq: string; type: string; fields: Record<string, unknown> }[]> => {
  await w.local.repo.fetch()
  return (await w.local.all()).map((message) => ({ seq: message.seq, type: message.type, fields: { ...message.fields } }))
}
/** Every file under a directory with its size, to prove nothing was written there. */
const listing = (dir: string): string[] => {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(`${relative(dir, path)}:${String(statSync(path).size)}`)
    }
  }
  walk(dir)
  return out.sort()
}

describe('GD-2: a patch from lg_patch_send is applied by Local as APPLIED', () => {
  it('posts CLAIM before PATCH, with the fields the protocol wants, and lg-patch-apply accepts it', async () => {
    const base = await baseSha()
    expect((await w.call('lg_draft_reset', { base })).text).toMatch(/drafts\/ reset to [0-9a-f]{12} \(\d+ files\)/)
    edit('src/a.txt', 'one\ntwo\n')
    edit('src/new.txt', 'brand new\n')
    const sent = await w.call('lg_patch_send', { message: 'Add new.txt and extend a.txt' })
    expect(sent.text).toMatch(/posted CLAIM #\d{4} and PATCH #\d{4}/)

    const messages = await channelMessages()
    const claim = messages.find((message) => message.type === 'CLAIM')
    const patch = messages.find((message) => message.type === 'PATCH')
    expect(claim && patch && Number(claim.seq) < Number(patch.seq)).toBe(true)
    expect(claim?.fields).toMatchObject({ scope: ['src/a.txt', 'src/new.txt'], implementer: 'global' })
    expect(patch?.fields).toMatchObject({ claim: claim?.seq, base, format: 'git-format-patch' })

    const name = String(patch?.fields['name'])
    const data = await w.local.readAttachment(`attachments/${String(patch?.seq)}/${name}`)
    expect(data).toBeDefined()
    expect(patch?.fields['bytes']).toBe(data?.length)
    expect(patch?.fields['sha256']).toBe(createHash('sha256').update(data ?? '').digest('hex'))

    const result = applyPatch({ name, base: String(patch?.fields['base']), bytes: Number(patch?.fields['bytes']), sha256: String(patch?.fields['sha256']), ...(data === undefined ? {} : { data }) }, w.work)
    expect(result).toMatchObject({ verdict: 'APPLIED' })
    expect(readFileSync(join(w.work, 'src/new.txt'), 'utf8')).toBe('brand new\n')
    expect(readFileSync(join(w.work, 'src/a.txt'), 'utf8')).toBe('one\ntwo\n')
    // Hard constraint 5: Local re-authors the applied commit, so Global's identity never lands in the repository.
    expect(await git(w.work, 'log', '-1', '--format=%an')).not.toBe('Global')
    expect(await git(w.work, 'log', '-1', '--format=%s')).toBe('Add new.txt and extend a.txt')
    // The same patch applied twice is a DUPLICATE, not a second change.
    expect(applyPatch({ name, base, bytes: data?.length ?? 0, sha256: String(patch?.fields['sha256']), ...(data === undefined ? {} : { data }) }, w.work).verdict).toBe('DUPLICATE')
  })

  it('sends everything since the reset base on a second send, and refuses a send with nothing new', async () => {
    const base = await baseSha()
    await w.call('lg_draft_reset', { base })
    edit('src/one.txt', '1\n')
    await w.call('lg_patch_send', { message: 'first' })
    expect(await refusal(w.call('lg_patch_send', { message: 'again' }))).toMatch(/no changes since the last patch/)
    edit('src/two.txt', '2\n')
    await w.call('lg_patch_send', { message: 'second' })
    const patches = (await channelMessages()).filter((message) => message.type === 'PATCH')
    expect(patches).toHaveLength(2)
    const latest = await w.local.readAttachment(`attachments/${patches[1]?.seq ?? ''}/${String(patches[1]?.fields['name'])}`)
    expect((latest?.toString('utf8').match(/^From [0-9a-f]{40} /gmu) ?? []).length).toBe(2)
    expect(patches[1]?.fields['base']).toBe(base)
  })

  it('carries binary changes', async () => {
    const base = await baseSha()
    await w.call('lg_draft_reset', { base })
    writeFileSync(join(w.drafts, 'blob.bin'), Buffer.from([0, 1, 2, 0xff, 0xfe, 0]))
    await w.call('lg_patch_send', { message: 'binary' })
    const patch = (await channelMessages()).find((message) => message.type === 'PATCH')
    const data = await w.local.readAttachment(`attachments/${patch?.seq ?? ''}/${String(patch?.fields['name'])}`)
    const applied = applyPatch({ name: String(patch?.fields['name']), base, bytes: data?.length ?? 0, sha256: String(patch?.fields['sha256']), ...(data === undefined ? {} : { data }) }, w.work)
    expect(applied.verdict).toBe('APPLIED')
    expect([...readFileSync(join(w.work, 'blob.bin'))]).toEqual([0, 1, 2, 0xff, 0xfe, 0])
  })
})

describe('lg_draft_reset and lg_patch_send refusals', () => {
  it('refuses to send before any reset', async () => {
    edit('x.txt', 'x\n')
    expect(await refusal(w.call('lg_patch_send', { message: 'm' }))).toMatch(/call lg_draft_reset first/)
  })

  it('refuses a base the mirror does not have, and an empty message', async () => {
    expect(await refusal(w.call('lg_draft_reset', { base: 'f'.repeat(40) }))).toMatch(/base is not a commit in the mirror/)
    expect(await refusal(w.call('lg_draft_reset', { base: '--output=/tmp/x' }))).toMatch(/must not start with "-"/)
    await w.call('lg_draft_reset', { base: await baseSha() })
    edit('x.txt', 'x\n')
    expect(await refusal(w.call('lg_patch_send', { message: '  ' }))).toMatch(/"message" must not be empty/)
  })

  it('refuses a patch that changes nothing, or that touches the evidence directory', async () => {
    await w.call('lg_draft_reset', { base: await baseSha() })
    expect(await refusal(w.call('lg_patch_send', { message: 'nothing' }))).toMatch(/identical to the base/)
    edit('evidence/M9/manifest.json', '{}\n')
    expect(await refusal(w.call('lg_patch_send', { message: 'forge' }))).toMatch(/may not change the evidence root \(evidence\/\), which only Local writes/)
    expect((await channelMessages()).filter((message) => message.type === 'PATCH')).toHaveLength(0)
  })

  it('refuses a nested git repository, which would become a gitlink', async () => {
    await w.call('lg_draft_reset', { base: await baseSha() })
    mkdirSync(join(w.drafts, 'sub'), { recursive: true })
    execFileSync('git', ['init', '--quiet', join(w.drafts, 'sub')], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    execFileSync('git', ['-C', join(w.drafts, 'sub'), '-c', 'user.name=n', '-c', 'user.email=n@x', 'commit', '--quiet', '--allow-empty', '-m', 'x'])
    expect(await refusal(w.call('lg_patch_send', { message: 'm' }))).toMatch(/sub is a nested git repository/)
  })

  it('refuses a patch larger than maxPatchBytes', async () => {
    await w.close()
    w = await createWorld({ config: { maxPatchBytes: 2000 } })
    await w.call('lg_draft_reset', { base: await baseSha() })
    edit('big.txt', `${'0123456789abcdef'.repeat(400)}\n`)
    expect(await refusal(w.call('lg_patch_send', { message: 'big' }))).toMatch(/larger than 2000 bytes/)
  })

  it('can resend after a failed PATCH post, and says which CLAIM was already written', async () => {
    await w.call('lg_draft_reset', { base: await baseSha() })
    edit('x.txt', 'x\n')
    const original = w.global.post.bind(w.global)
    let failures = 1
    w.global.post = (async (input: Parameters<typeof original>[0]) => {
      if (input.type === 'PATCH' && failures-- > 0) throw new Error('push rejected')
      return await original(input)
    }) as typeof w.global.post
    expect(await refusal(w.call('lg_patch_send', { message: 'm' }))).toMatch(/CLAIM #\d{4} was posted but the PATCH was not: push rejected/)
    expect((await w.call('lg_patch_send', { message: 'm' })).text).toMatch(/posted CLAIM/)
    expect((await channelMessages()).filter((message) => message.type === 'PATCH')).toHaveLength(1)
  })

  it('replaces everything in drafts/ on reset, links included, without following them', async () => {
    const outside = join(w.root, 'outside.txt')
    writeFileSync(outside, 'keep\n')
    await w.call('lg_draft_reset', { base: await baseSha() })
    edit('stray.txt', 's\n')
    symlinkSync(w.root, join(w.drafts, 'link'))
    const done = await w.call('lg_draft_reset', { base: await baseSha() })
    expect(done['files']).toBe(2)
    expect(existsSync(join(w.drafts, 'stray.txt'))).toBe(false)
    expect(existsSync(join(w.drafts, 'link'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('keep\n')
    expect(readFileSync(join(w.drafts, 'src/a.txt'), 'utf8')).toBe('one\n')
  })
})

describe('the drafts git dir is out of Global\'s reach and nothing in drafts/ can run', () => {
  const plant = (marker: string): void => {
    const shell = (name: string): string => `#!/bin/sh\ntouch '${marker}-${name}'\n`
    mkdirSync(join(w.drafts, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(w.drafts, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch '${marker}-fsmonitor'\n\thooksPath = ${join(w.drafts, '.git', 'hooks')}\n[filter "evil"]\n\tclean = touch '${marker}-filter'\n\tsmudge = touch '${marker}-smudge'\n\tprocess = touch '${marker}-process'\n[diff "evil"]\n\ttextconv = touch '${marker}-textconv'\n\tcommand = touch '${marker}-diff'\n`)
    for (const hook of ['pre-commit', 'post-commit', 'commit-msg', 'pre-push', 'reference-transaction', 'post-index-change', 'pre-auto-gc', 'post-checkout', 'post-merge']) {
      writeFileSync(join(w.drafts, '.git', 'hooks', hook), shell(hook), { mode: 0o755 })
    }
    mkdirSync(join(w.drafts, 'hooks'), { recursive: true })
    writeFileSync(join(w.drafts, 'hooks', 'pre-commit'), shell('drafts-hooks'), { mode: 0o755 })
    writeFileSync(join(w.drafts, '.gitattributes'), '* filter=evil diff=evil\n')
    writeFileSync(join(w.drafts, '.gitmodules'), `[submodule "x"]\n\tpath = x\n\turl = ${join(w.root, 'nowhere')}\n\tupdate = !touch '${marker}-submodule'\n`)
  }
  const markers = (marker: string): string[] => readdirSync(w.root).filter((name) => name.startsWith(`${marker.split('/').pop() ?? ''}-`))

  it('the same files do run when git is pointed at them naively (control)', () => {
    const marker = join(w.root, 'control')
    const control = join(w.root, 'control-repo')
    mkdirSync(control)
    execFileSync('git', ['init', '--quiet', control], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    writeFileSync(join(control, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = touch '${marker}-fsmonitor'\n`)
    writeFileSync(join(control, 'f.txt'), 'x\n')
    execFileSync('git', ['status'], { cwd: control, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
    expect(existsSync(`${marker}-fsmonitor`)).toBe(true)
  })

  it('never executes hooks, fsmonitor, filters, textconv or submodule commands planted under drafts/', async () => {
    const marker = join(w.root, 'pwned')
    await w.call('lg_draft_reset', { base: await baseSha() })
    plant(marker)
    edit('src/new.txt', 'content\n')
    const sent = await w.call('lg_patch_send', { message: 'with traps in the tree' })
    expect(sent.text).toMatch(/posted CLAIM/)
    // A reset with the traps still in place runs nothing either.
    plant(marker)
    await w.call('lg_draft_reset', { base: await baseSha() })
    expect(markers(marker)).toEqual([])
    // The planted .git/ is just files: it is not in the patch, the .gitattributes is.
    const claim = (await channelMessages()).find((message) => message.type === 'CLAIM')
    expect(claim?.fields['scope']).toEqual(['.gitattributes', '.gitmodules', 'hooks/pre-commit', 'src/new.txt'])
  })

  it('keeps the git dir outside drafts/ and outside every path Global may write', async () => {
    await w.call('lg_draft_reset', { base: await baseSha() })
    expect(existsSync(join(w.draftsGit, 'HEAD'))).toBe(true)
    expect(existsSync(join(w.drafts, '.git'))).toBe(false)
    expect(w.state.protectedList()).toContain(w.draftsGit)
    const scope = resolveScopeConfig({ workspace: w.workspace })
    const protectedPaths = w.state.protectedList()
    for (const tool of ['write', 'edit']) {
      expect(checkPath(scope, tool, join(w.draftsGit, 'config'), w.workspace, [])).toMatch(/may only write inside/)
      expect(checkPath(scope, tool, join(w.draftsGit, 'hooks', 'pre-commit'), w.workspace, protectedPaths)).toMatch(/may only write inside|protected path/)
      expect(checkPath(scope, tool, join(w.drafts, 'src', 'a.txt'), w.workspace, protectedPaths)).toBeUndefined()
    }
    // Even if an operator widened the write roots to the whole workspace, the protected list still wins.
    const wide = resolveScopeConfig({ workspace: w.workspace, writeRoots: ['.'] })
    expect(checkPath(wide, 'write', join(w.draftsGit, 'config'), w.workspace, protectedPaths)).toMatch(/protected path/)
  })

  it('refuses a configuration that would put the git dir where Global can write', () => {
    const base = { workspace: w.workspace }
    expect(() => resolveDirectiveConfig({ ...base, draftsGitDir: 'drafts/.git' })).toThrow(/must not contain each other/)
    expect(() => resolveDirectiveConfig({ ...base, draftsGitDir: 'scratch/git' }, [join(w.workspace, 'scratch')])).toThrow(/overlaps the write root/)
    expect(() => resolveDirectiveConfig({ ...base, draftsGitDir: 'drafts.git' }, [w.workspace])).toThrow(/overlaps the write root/)
    expect(resolveDirectiveConfig(base, [join(w.workspace, 'drafts')]).draftsGitDir).toBe(join(w.workspace, 'drafts.git'))
  })

  it('refuses to run when drafts/ has been replaced by a link', async () => {
    await w.call('lg_draft_reset', { base: await baseSha() })
    const { rmSync } = await import('node:fs')
    rmSync(w.drafts, { recursive: true })
    symlinkSync(w.root, w.drafts)
    expect(await refusal(w.call('lg_draft_reset', { base: await baseSha() }))).toMatch(/is not a plain directory/)
  })

  it('never writes into the mirror', async () => {
    const before = listing(join(w.root, 'mirror.git'))
    await w.call('lg_draft_reset', { base: await baseSha() })
    edit('src/m.txt', 'm\n')
    await w.call('lg_patch_send', { message: 'm' })
    await w.call('lg_draft_reset', { base: await baseSha() })
    expect(listing(join(w.root, 'mirror.git'))).toEqual(before)
  })
})
