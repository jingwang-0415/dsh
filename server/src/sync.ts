import type Database from 'better-sqlite3'
import { runGit } from './gitRunner.js'
import { REVLIST_FORMAT, parseRevList, type CommitInfo } from './parse.js'
import type { RefChange } from './refDiff.js'

export function listCommits(
  mirrorDir: string, range: string, opts: { maxCount?: number; skip?: number } = {}
): Promise<CommitInfo[]> {
  const args = ['rev-list', range]
  if (opts.skip) args.push('--skip', String(opts.skip))
  if (opts.maxCount) args.push('--max-count', String(opts.maxCount))
  args.push(REVLIST_FORMAT)
  return runGit(mirrorDir, args).then(r => parseRevList(r.stdout))
}

export function insertCommits(db: Database.Database, repoId: string, branch: string, commits: CommitInfo[]): CommitInfo[] {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO commits
     (repo_id, sha, author_name, author_email, committed_at, subject, body, first_seen_branch, first_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  const inserted: CommitInfo[] = []
  db.transaction((list: CommitInfo[]) => {
    for (const c of list) {
      const r = stmt.run(repoId, c.sha, c.authorName, c.authorEmail, c.committedAt, c.subject, c.body, branch, now)
      if (r.changes > 0) inserted.push(c)
    }
  })(commits)
  return inserted
}

export function upsertBranch(db: Database.Database, repoId: string, name: string, sha: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO branches (repo_id, name, head_sha, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)
     ON CONFLICT(repo_id, name) DO UPDATE SET
       head_sha = excluded.head_sha, updated_at = excluded.updated_at, status = 'active'`
  ).run(repoId, name, sha, now, now)
}

export function markBranchDeleted(db: Database.Database, repoId: string, name: string): void {
  db.prepare(`UPDATE branches SET status='deleted', updated_at=? WHERE repo_id=? AND name=?`)
    .run(Date.now(), repoId, name)
}

export async function backfillRepo(
  db: Database.Database, repoId: string, mirrorDir: string, heads: { branch: string; sha: string }[]
): Promise<number> {
  let total = 0
  for (const { branch, sha } of heads) {
    const commits = await listCommits(mirrorDir, sha)
    total += insertCommits(db, repoId, branch, commits).length
    upsertBranch(db, repoId, branch, sha)
  }
  return total
}

export interface ApplyResult {
  newCommits: number
  insertedByBranch: Record<string, CommitInfo[]>
}

export async function applyChanges(
  db: Database.Database, repoId: string, mirrorDir: string, changes: RefChange[]
): Promise<ApplyResult> {
  const insertedByBranch: Record<string, CommitInfo[]> = {}
  let newCommits = 0
  for (const ch of changes) {
    if (ch.type === 'added') {
      const inserted = insertCommits(db, repoId, ch.branch, await listCommits(mirrorDir, ch.newSha))
      upsertBranch(db, repoId, ch.branch, ch.newSha)
      insertedByBranch[ch.branch] = inserted
      newCommits += inserted.length
    } else if (ch.type === 'fast-forward') {
      const inserted = insertCommits(db, repoId, ch.branch, await listCommits(mirrorDir, `${ch.oldSha}..${ch.newSha}`))
      upsertBranch(db, repoId, ch.branch, ch.newSha)
      insertedByBranch[ch.branch] = inserted
      newCommits += inserted.length
    } else if (ch.type === 'force-push') {
      db.prepare(`UPDATE branches SET head_sha=?, rewritten_at=?, updated_at=? WHERE repo_id=? AND name=?`)
        .run(ch.newSha, Date.now(), Date.now(), repoId, ch.branch)
    } else {
      markBranchDeleted(db, repoId, ch.branch)
    }
  }
  return { newCommits, insertedByBranch }
}

export function startFetchEvent(db: Database.Database, repoId: string): number {
  const r = db.prepare(`INSERT INTO fetch_events (repo_id, started_at, status) VALUES (?,?, 'running')`).run(repoId, Date.now())
  return Number(r.lastInsertRowid)
}

export function finishFetchEvent(
  db: Database.Database, id: number, status: 'ok' | 'failed', newCommits = 0, error: string | null = null
): void {
  db.prepare(`UPDATE fetch_events SET finished_at=?, status=?, new_commits=?, error=? WHERE id=?`)
    .run(Date.now(), status, newCommits, error, id)
}
