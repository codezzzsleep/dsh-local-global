import { describe, expect, it } from 'vitest'

import { DEFAULT_SECRET_PATTERNS, TREE_DIGEST, domainHits, resolveEvidenceConfig, secretHits } from '../src/evidence.js'

describe('secret scan (EV-5)', () => {
  it('flags a token= line and a key', () => {
    expect(secretHits('dsh web: http://127.0.0.1:3076/?token=abcdefghijkl', DEFAULT_SECRET_PATTERNS)).toHaveLength(1)
    expect(secretHits('Authorization: Bearer xyz', DEFAULT_SECRET_PATTERNS)).toHaveLength(1)
    expect(secretHits('sk-abcdefghijklmnop', DEFAULT_SECRET_PATTERNS)).toHaveLength(1)
  })

  it('passes a redacted file', () => {
    expect(secretHits('dsh web: http://127.0.0.1:3076/?token=<REDACTED>', DEFAULT_SECRET_PATTERNS)).toEqual([])
    expect(secretHits('ordinary evidence output', DEFAULT_SECRET_PATTERNS)).toEqual([])
  })
})

describe('resolveEvidenceConfig', () => {
  it('defaults the digest to the tree without the evidence root, and the evidence root', () => {
    // Not `git rev-parse HEAD`: committing a manifest moves HEAD and would make it stale at once.
    const config = resolveEvidenceConfig({}, '/srv/repo')
    expect(config.digestCommand).toBe(TREE_DIGEST)
    expect(config.evidenceRoot).toBe('/srv/repo/evidence')
    expect(config.secretPatterns.length).toBeGreaterThan(5)
  })

  it('honours overrides', () => {
    const config = resolveEvidenceConfig({ digestCommand: 'git log -1 --format=%H', evidenceRoot: 'ev', secretPatterns: ['x-token'] }, '/srv/repo')
    expect(config.digestCommand).toBe('git log -1 --format=%H')
    expect(config.evidenceRoot).toBe('/srv/repo/ev')
    expect(config.secretPatterns).toEqual(['x-token'])
  })
})

describe('config and scan helpers', () => {
  it('accepts the argv form of digestCommand that docs/implementation.md shows', () => {
    expect(resolveEvidenceConfig({ digestCommand: ['git', 'log', '-1', '--format=%H x'] }, '/srv/repo').digestCommand).toBe("git log -1 '--format=%H x'")
  })

  it('rejects an invalid secret pattern at start-up instead of failing at scan time', () => {
    expect(() => resolveEvidenceConfig({ secretPatterns: ['('] }, '/srv/repo')).toThrow(/not a valid regular expression/)
  })

  it('finds configured public domains, subdomains included, and not look-alikes', () => {
    const domains = resolveEvidenceConfig({ publicDomains: ['Example.com'] }, '/srv/repo').publicDomains
    expect(domains).toEqual(['example.com'])
    expect(domainHits('see https://api.EXAMPLE.com/x', domains)).toEqual(['example.com'])
    expect(domainHits('mail me@example.com', domains)).toEqual(['example.com'])
    expect(domainHits('notexample.com and example.community', domains)).toEqual([])
  })
})

describe('stale classification (EV-4)', () => {
  it('marks only the manifests whose digest moved', async () => {
    const { staleOf } = await import('../src/evidence.js')
    const entries: [string, string][] = [
      ['m3-protocol', 'abc'],
      ['m3-evidence', 'def'],
    ]
    expect(staleOf(entries, 'abc')).toEqual(['m3-evidence'])
    expect(staleOf(entries, 'abc')).toEqual(['m3-evidence'])
    expect(staleOf(entries, 'zzz')).toEqual(['m3-protocol', 'm3-evidence'])
    expect(staleOf(entries, 'abc')).not.toContain('m3-protocol')
  })

  it('treats every manifest as stale once the digest moves, and none when it matches', async () => {
    const { staleOf } = await import('../src/evidence.js')
    expect(staleOf([], 'abc')).toEqual([])
    expect(staleOf([['t', 'abc']], 'abc')).toEqual([])
  })
})
