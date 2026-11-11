import { GitCommandError, runGit } from './gitRunner.js'
import type { RefSnapshot } from './mirror.js'

export type RawChange =
  | { type: 'added'; branch: string; newSha: string }
  | { type: 'updated'; branch: string; oldSha: string; newSha: string }
  | { type: 'deleted'; branch: string; oldSha: string }

export type RefChange =
  | { type: 'added'; branch: string; newSha: string }
  | { type: 'fast-forward'; branch: string; oldSha: string; newSha: string }
  | { type: 'force-push'; branch: string; oldSha: string; newSha: string }
  | { type: 'deleted'; branch: string; oldSha: string }

export function diffRefs(before: RefSnapshot, after: RefSnapshot): RawChange[] {
  const changes: RawChange[] = []
  for (const [branch, newSha] of Object.entries(after)) {
    const oldSha = before[branch]
    if (!oldSha) changes.push({ type: 'added', branch, newSha })
    else if (oldSha !== newSha) changes.push({ type: 'updated', branch, oldSha, newSha })
  }
  for (const [branch, oldSha] of Object.entries(before)) {
    if (!(branch in after)) changes.push({ type: 'deleted', branch, oldSha })
  }
  return changes
}

export async function classifyChange(mirrorDir: string, change: RawChange): Promise<RefChange> {
  if (change.type !== 'updated') return change
  const ok = await runGit(mirrorDir, ['merge-base', '--is-ancestor', change.oldSha, change.newSha])
    .then(() => true)
    .catch((err: unknown) => {
      // 归因分级：GitCommandError（任意退出码——1=非祖先语义；128=镜像缺对象常见瞬态，
      // 语义等价）才算"git 给出了答案"，归 force-push；
      // spawn ENOENT（cwd 不存在）/超时等基础设施故障以非 GitCommandError 的 plain Error
      // reject，必须重抛——调用方 scheduler.runOnce 的 catch 按失败轮退避处理，
      // 不得静默吞成 force-push（历史归因污染）
      if (err instanceof GitCommandError) return false
      throw err
    })
  return ok
    ? { type: 'fast-forward', branch: change.branch, oldSha: change.oldSha, newSha: change.newSha }
    : { type: 'force-push', branch: change.branch, oldSha: change.oldSha, newSha: change.newSha }
}

export async function classifyChanges(mirrorDir: string, changes: RawChange[]): Promise<RefChange[]> {
  const out: RefChange[] = []
  for (const c of changes) out.push(await classifyChange(mirrorDir, c))
  return out
}
