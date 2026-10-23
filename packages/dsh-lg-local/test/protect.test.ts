import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PROTECTED_PATHS, apply, protectReason, resolveProtectConfig } from '../src/protect.js'
import { agentIn, fakeCtx, tmp } from './fake-ctx.js'

/** A project dir next to a protected "Global home", with a file inside it. */
function layout(): { root: string; project: string; secret: string; config: ReturnType<typeof resolveProtectConfig> } {
  const root = tmp('protect')
  const project = join(root, 'project')
  const secret = join(root, 'global-home')
  mkdirSync(project)
  mkdirSync(join(secret, 'workspace'), { recursive: true })
  writeFileSync(join(secret, 'workspace', 'LG-ROLE.md'), 'role\n')
  return { root, project, secret, config: resolveProtectConfig({ protectedPaths: [secret] }) }
}

describe('PT-1: path resolution is physical and uses the current directory', () => {
  it('follows a symlink into the protected area', () => {
    const { project, secret, config } = layout()
    symlinkSync(secret, join(project, 'link'))
    expect(protectReason(config, 'read', { file_path: join(project, 'link', 'workspace', 'LG-ROLE.md') }, project)).toContain('protected path')
    expect(protectReason(config, 'write', { file_path: 'link/new.txt' }, project)).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'cat link/workspace/LG-ROLE.md' }, project)).toContain('protected path')
  })

  it('follows a dangling symlink to where a write would land', () => {
    const { project, secret, config } = layout()
    symlinkSync(join(secret, 'workspace', 'planted.md'), join(project, 'dangling'))
    expect(protectReason(config, 'write', { file_path: 'dangling' }, project)).toContain('protected path')
    symlinkSync(join(project, 'nowhere'), join(project, 'harmless'))
    expect(protectReason(config, 'write', { file_path: 'harmless' }, project)).toBeUndefined()
  })

  it('normalises a/../b before judging', () => {
    const { project, secret, config } = layout()
    expect(protectReason(config, 'read', { file_path: join(project, 'x', '..', '..', 'global-home', 'workspace', 'LG-ROLE.md') }, project)).toContain('protected path')
    expect(protectReason(config, 'bash', { command: `cat ${project}/src/../../global-home/workspace/LG-ROLE.md` }, project)).toContain('protected path')
    expect(protectReason(config, 'read', { file_path: join(project, 'x', '..', 'ok.txt') }, project)).toBeUndefined()
    expect(secret).toContain('global-home')
  })

  it('treats a protected root that is itself a symlink as protected', () => {
    const { root, secret } = layout()
    const alias = join(root, 'alias')
    symlinkSync(secret, alias)
    const config = resolveProtectConfig({ protectedPaths: [alias] })
    expect(protectReason(config, 'read', { file_path: join(secret, 'workspace', 'LG-ROLE.md') }, root)).toContain('protected path')
  })

  it('resolves relative paths against the current directory, not the original one', () => {
    const { project, secret, config } = layout()
    const fake = fakeCtx({ workingDirectory: { get: () => join(secret, 'workspace') } })
    apply(fake.ctx, { protectedPaths: [secret] })
    // The session started in the project but has since moved into the protected area.
    expect(fake.guard('read', { file_path: 'LG-ROLE.md' }, agentIn(project))).toContain('protected path')
    expect(protectReason(config, 'read', { file_path: 'LG-ROLE.md' }, join(secret, 'workspace'))).toContain('protected path')
    // The header is only the fallback.
    const plain = fakeCtx()
    apply(plain.ctx, { protectedPaths: [secret] })
    expect(plain.guard('read', { file_path: 'LG-ROLE.md' }, agentIn(project))).toBeUndefined()
  })

  it('expands ~ in protectedPaths and in the tool arguments', () => {
    const config = resolveProtectConfig({ protectedPaths: ['~/.lg-test-global'] })
    expect(config.protectedPaths).toEqual([join(homedir(), '.lg-test-global')])
    expect(protectReason(config, 'read', { file_path: '~/.lg-test-global/home/x' }, '/tmp')).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'ls ~/.lg-test-global' }, '/tmp')).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'ls $HOME/.lg-test-global/home' }, '/tmp')).toContain('protected path')
  })

  it('protects glob and grep that default to the current directory, and a glob pattern prefix', () => {
    const { project, secret, config } = layout()
    expect(protectReason(config, 'grep', { pattern: 'x' }, join(secret, 'workspace'))).toContain('protected path')
    expect(protectReason(config, 'glob', { pattern: `${secret}/**/*.md` }, project)).toContain('protected path')
    expect(protectReason(config, 'glob', { pattern: '**/*.ts' }, project)).toBeUndefined()
  })

  it('sees through the other tools that carry a path: lg_apply_patch cwd, lg_evidence_add raw, working_directory', () => {
    const { project, secret, config } = layout()
    expect(protectReason(config, 'lg_apply_patch', { seq: '0004', cwd: secret }, project)).toContain('protected path')
    expect(protectReason(config, 'lg_evidence_add', { raw: [join(secret, 'workspace', 'LG-ROLE.md')] }, project)).toContain('protected path')
    expect(protectReason(config, 'working_directory', { path: secret }, project)).toContain('protected path')
    expect(protectReason(config, 'lg_apply_patch', { seq: '0004' }, project)).toBeUndefined()
  })
})

describe('PT-1: shell text is tokenized, not substring-matched', () => {
  it('follows cd plus a relative path', () => {
    const { root, project, config } = layout()
    expect(protectReason(config, 'bash', { command: 'cd ../global-home && cat workspace/LG-ROLE.md' }, project)).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'cd .. ; ls global-home' }, project)).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'cd workspace; cat x' }, join(root, 'global-home'))).toContain('protected path')
    expect(protectReason(config, 'bash', { command: 'cd src && cat a.ts' }, project)).toBeUndefined()
  })

  it('sees through quote splitting, escapes, substitutions and wrappers', () => {
    const { secret, project, config } = layout()
    for (const command of [
      `cat ${secret.slice(0, -4)}""${secret.slice(-4)}/workspace/LG-ROLE.md`,
      `cat '${secret}'/workspace/LG-ROLE.md`,
      `cat ${secret.replace('global', 'gl\\obal')}/workspace/LG-ROLE.md`,
      `echo $(cat ${secret}/workspace/LG-ROLE.md)`,
      `sh -c 'cat ${secret}/workspace/LG-ROLE.md'`,
      `X=${secret}; cat $X/workspace/LG-ROLE.md`,
      `cat < ${secret}/workspace/LG-ROLE.md`,
      `echo hi > ${secret}/workspace/out.txt`,
      `grep --file=${secret}/workspace/LG-ROLE.md x`,
    ]) {
      expect(protectReason(config, 'bash', { command }, project), command).toContain('protected path')
    }
  })

  it('checks pwsh like bash and lets ordinary commands through', () => {
    const { secret, project, config } = layout()
    expect(protectReason(config, 'pwsh', { command: `Get-Content ${secret}/workspace/LG-ROLE.md` }, project)).toContain('protected path')
    for (const command of ['git status', 'pnpm -r test', 'ls -la', 'echo global-home', 'cat src/a.ts | head -5']) {
      expect(protectReason(config, 'bash', { command }, project), command).toBeUndefined()
    }
  })
})

describe('the default configuration', () => {
  it('protects Global’s home convention (~/.lg-global) when nothing is configured', () => {
    expect(DEFAULT_PROTECTED_PATHS).toEqual(['~/.lg-global'])
    const config = resolveProtectConfig({})
    expect(config.protectedPaths).toEqual([join(homedir(), '.lg-global')])
    expect(protectReason(config, 'read', { file_path: join(homedir(), '.lg-global', 'workspace', 'LG-ROLE.md') }, '/tmp')).toContain('protected path')
  })

  it('takes an explicit list literally, even an empty one', () => {
    expect(resolveProtectConfig({ protectedPaths: [] }).protectedPaths).toEqual([])
  })

  it('publishes the check other plugins use for their own tools', () => {
    const { project, secret } = layout()
    const fake = fakeCtx()
    apply(fake.ctx, { protectedPaths: [secret] })
    const service = fake.services.get('lgProtect') as { check(tool: string, args: unknown, cwd: string): string | undefined }
    expect(service.check('lg_apply_patch', { cwd: secret }, project)).toContain('protected path')
    expect(service.check('lg_apply_patch', { cwd: project }, project)).toBeUndefined()
  })
})
