import { runGit } from './gitRunner.js'
import { listCommits } from './sync.js'
import type { CommitInfo } from './parse.js'

export type BranchStatus = 'active' | 'deleted' | 'rewritten'

export interface BranchInclusion { branch: string; contains: boolean; status: BranchStatus }

export interface InclusionBranch { name: string; status: BranchStatus }

export async function inclusionForCommit(
  mirrorDir: string, sha: string, branches: InclusionBranch[]
): Promise<BranchInclusion[]> {
  const { stdout } = await runGit(mirrorDir, ['branch', '--contains', sha, '--format=%(refname:short)'])
  const containing = new Set(stdout.split('\n').filter(Boolean))
  return branches.map(b => ({ branch: b.name, contains: containing.has(b.name), status: b.status }))
}

export async function aheadBehind(
  mirrorDir: string, base: string, target: string
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await runGit(mirrorDir, [
    'rev-list', '--left-right', '--count', `refs/heads/${base}...refs/heads/${target}`
  ])
  const [left, right] = stdout.trim().split('\t').map(Number)
  return { ahead: left ?? 0, behind: right ?? 0 }
}

export interface CompareResult {
  ahead: number
  behind: number
  aheadCommits: CommitInfo[]
  behindCommits: CommitInfo[]
}

export async function compareBranches(
  mirrorDir: string, base: string, target: string
): Promise<CompareResult> {
  const [ab, aheadCommits, behindCommits] = await Promise.all([
    aheadBehind(mirrorDir, base, target),
    listCommits(mirrorDir, `refs/heads/${target}..refs/heads/${base}`),
    listCommits(mirrorDir, `refs/heads/${base}..refs/heads/${target}`)
  ])
  return { ahead: ab.ahead, behind: ab.behind, aheadCommits, behindCommits }
}
