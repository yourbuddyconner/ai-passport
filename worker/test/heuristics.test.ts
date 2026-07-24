import { describe, expect, it } from 'vitest'
import {
  classifyCommand, computeOutcome, deprefix, isCommit, isGeneratedPath,
  isShip, isVerify, median, normalizeExt, type OutcomeEvent,
} from '../src/parsers/heuristics'

describe('deprefix', () => {
  it('strips cd/env/source prefixes', () => {
    expect(deprefix('cd worker && npx vitest run')).toBe('npx vitest run')
    expect(deprefix('ENVIRONMENT=dev && make deploy')).toBe('make deploy')
    expect(deprefix('export FOO=1; nvm use 22; pnpm test')).toBe('pnpm test')
    expect(deprefix('git status')).toBe('git status')
  })

  it('handles a huge run of prefix segments without quadratic blowup (perf sanity)', () => {
    const cmd = 'cd x;'.repeat(50_000) + 'pnpm test'
    expect(classifyCommand(cmd)).toBe('test')
  })
})

describe('classifyCommand', () => {
  const cases: Array<[string, string]> = [
    ['cd worker && npx vitest run', 'test'],
    ['pnpm test', 'test'],
    ['cargo test -p passport-verifier', 'test'],
    ['pnpm install', 'package'],
    ['npm run build', 'build'],
    ['VAR=1 tsc --noEmit', 'build'],
    ['git commit -m "x"', 'git'],
    ['rg -n "foo" src/', 'search'],
    ['gh pr view 12', 'network'],
    ['npx wrangler deploy', 'ops'],
    ['kubectl get pods', 'ops'],
    ['python3 scripts/x.py', 'run'],
    ['cat file.txt', 'file'],
    ['sed -i "" "s/a/b/" f', 'file'],
    ['some-custom-binary --flag', 'other'],
  ]
  for (const [cmd, want] of cases) {
    it(`${cmd} → ${want}`, () => expect(classifyCommand(cmd)).toBe(want))
  }
})

describe('verify/commit/ship detection', () => {
  it('isVerify matches test and build', () => {
    expect(isVerify('cd worker && npx vitest run')).toBe(true)
    expect(isVerify('cargo build --release')).toBe(true)
    expect(isVerify('git status')).toBe(false)
  })
  it('isCommit', () => {
    expect(isCommit('git add -A && git commit -m "x"')).toBe(true)
    expect(isCommit('git status')).toBe(false)
  })
  it('isShip', () => {
    expect(isShip('git push origin main')).toBe(true)
    expect(isShip('gh pr create --fill')).toBe(true)
    expect(isShip('npx wrangler deploy')).toBe(true)
    expect(isShip('git commit -m x')).toBe(false)
  })
})

describe('paths', () => {
  it('isGeneratedPath', () => {
    expect(isGeneratedPath('/a/package-lock.json')).toBe(true)
    expect(isGeneratedPath('/a/node_modules/x/y.js')).toBe(true)
    expect(isGeneratedPath('/a/src/app.min.js')).toBe(true)
    expect(isGeneratedPath('/a/src/app.ts')).toBe(false)
  })
  it('normalizeExt', () => {
    expect(normalizeExt('/a/b/App.TSX')).toBe('ts')
    expect(normalizeExt('/a/b/mod.rs')).toBe('rs')
    expect(normalizeExt('/a/b/Makefile')).toBe('other')
  })
})

describe('median', () => {
  it('handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('computeOutcome', () => {
  const ev = (kind: OutcomeEvent['kind'], ok: boolean, seq: number): OutcomeEvent => ({ kind, ok, seq })
  it('no edits: research vs trivial by tool calls', () => {
    expect(computeOutcome([], 10)).toBe('research')
    expect(computeOutcome([], 9)).toBe('trivial')
  })
  it('shipped: ship after last edit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('ship', true, 2)], 5)).toBe('shipped'))
  it('landed: commit after last edit + green after first edit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2), ev('commit', true, 3)], 5)).toBe('landed'))
  it('committed: commit after last edit, no verify ever', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('commit', true, 2)], 5)).toBe('committed'))
  it('green: last post-edit verify ok, no commit', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2)], 5)).toBe('green'))
  it('red: last post-edit verify failed', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('verify', true, 2), ev('edit', true, 3), ev('verify', false, 4)], 5)).toBe('red'))
  it('unverified: edits only', () =>
    expect(computeOutcome([ev('edit', true, 1)], 5)).toBe('unverified'))
  it('green before any edit does not count', () =>
    expect(computeOutcome([ev('verify', true, 1), ev('edit', true, 2)], 5)).toBe('unverified'))
  it('failed ship does not count', () =>
    expect(computeOutcome([ev('edit', true, 1), ev('ship', false, 2)], 5)).toBe('unverified'))
})
