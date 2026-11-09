import { runGit } from './gitRunner.js'
import { branchFingerprints, buildPathspecs, type Fingerprint } from './patchid.js'
import type { CommitInfo } from './parse.js'

export interface MatchedPair { patchId: string; shaA: string; shaB: string; subjectA: string }

export interface CrossCompareResult {
  onlyInA: CommitInfo[]
  onlyInB: CommitInfo[]
  matchedPairs: MatchedPair[]
  stats: { aTotal: number; bTotal: number; matched: number; onlyA: number; onlyB: number }
}

export function mergePatchMaps(a: Fingerprint[], b: Fingerprint[]): {
  onlyInA: Fingerprint[]; onlyInB: Fingerprint[]; matched: { patchId: string; shaA: string; shaB: string }[]
} {
  const bIds = new Map(b.map(x => [x.patchId, x.sha]))
  const aIds = new Map(a.map(x => [x.patchId, x.sha]))
  return {
    onlyInA: a.filter(x => !bIds.has(x.patchId)),
    onlyInB: b.filter(x => !aIds.has(x.patchId)),
    matched: a.filter(x => bIds.has(x.patchId)).map(x => ({ patchId: x.patchId, shaA: x.sha, shaB: bIds.get(x.patchId)! }))
  }
}

export function parseShow(raw: string): CommitInfo[] {
  return raw.split('\n').filter(Boolean).map(line => {
    const [sha, an, ct, s] = line.split('\x1f')
    return { sha, authorName: an ?? '', authorEmail: '', committedAt: Number(ct) || 0, subject: s ?? '', body: '' }
  })
}

// 大仓化：单次 argv 的 sha 数上限，规避 ARG_MAX/argv+env 上限（macOS ~256KB / Linux ~2MB）
const SHOW_BATCH = 200

export async function showCommits(mirrorDir: string, shas: string[]): Promise<CommitInfo[]> {
  if (shas.length === 0) return []
  const out: CommitInfo[] = []
  for (let i = 0; i < shas.length; i += SHOW_BATCH) {
    const { stdout } = await runGit(mirrorDir, ['show', '-s', '--format=%H%x1f%an%x1f%ct%x1f%s', ...shas.slice(i, i + SHOW_BATCH)])
    out.push(...parseShow(stdout))
  }
  return out
}

export async function crossCompare(
  mirrorA: string, branchA: string, mirrorB: string, branchB: string,
  include: string[], exclude: string[]
): Promise<CrossCompareResult> {
  const pathspecs = buildPathspecs(include, exclude)
  const [fa, fb] = await Promise.all([
    branchFingerprints(mirrorA, branchA, pathspecs),
    branchFingerprints(mirrorB, branchB, pathspecs)
  ])
  const { onlyInA, onlyInB, matched } = mergePatchMaps(fa, fb)
  const [metaA, metaB, subjectsA] = await Promise.all([
    showCommits(mirrorA, onlyInA.map(x => x.sha)),
    showCommits(mirrorB, onlyInB.map(x => x.sha)),
    showCommits(mirrorA, matched.map(x => x.shaA))
  ])
  const subjectBySha = new Map(subjectsA.map(c => [c.sha, c.subject]))
  return {
    onlyInA: metaA,
    onlyInB: metaB,
    matchedPairs: matched.map(m => ({ patchId: m.patchId, shaA: m.shaA, shaB: m.shaB, subjectA: subjectBySha.get(m.shaA) ?? '' })),
    stats: { aTotal: fa.length, bTotal: fb.length, matched: matched.length, onlyA: onlyInA.length, onlyB: onlyInB.length }
  }
}
