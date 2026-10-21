import { describe, expect, it } from 'vitest'

import { DEFAULT_SECRET_PATTERNS, resolveEvidenceConfig, secretHits } from '../src/evidence.js'

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
  it('defaults the digest command and the evidence root', () => {
    const config = resolveEvidenceConfig({}, '/srv/repo')
    expect(config.digestCommand).toBe('git rev-parse HEAD')
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
