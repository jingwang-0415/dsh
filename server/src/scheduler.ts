import { rmSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { isBranchExcluded, type RepoConfig } from './config.js'
import { ensureMirror, fetchMirror, snapshotRefs } from './mirror.js'
import { diffRefs, classifyChanges } from './refDiff.js'
import { applyChanges, backfillRepo, finishFetchEvent, startFetchEvent } from './sync.js'
import type { CommitInfo } from './parse.js'

export type SchedulerState = 'starting' | 'running' | 'idle' | 'backoff'

export interface SchedulerStatus {
  state: SchedulerState
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveFailures: number
  lastError: string | null
  lastNewCommits: number | null
}

export interface SchedulerHandlers {
  onCommitsNew(branch: string, commits: CommitInfo[]): void
  onBranchesUpdated(): void
  onStatus(s: SchedulerStatus): void
}

export interface SchedulerDeps {
  db: Database.Database
  repo: RepoConfig
  mirrorDir: string
  handlers: SchedulerHandlers
}

export function nextBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000)
}

export interface RunOnceResult { skipped: boolean; newCommits?: number; error?: string }

const CORRUPT_RE = /corrupt|not a git repository|does not appear to be a git repository/i

export class Scheduler {
  status: SchedulerStatus = {
    state: 'starting', lastRunAt: null, nextRunAt: null,
    consecutiveFailures: 0, lastError: null, lastNewCommits: null
  }
  private timer: NodeJS.Timeout | null = null
  running = false

  constructor(private deps: SchedulerDeps) {}

  start(): void { void this.loop() }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async loop(): Promise<void> {
    await this.runOnce()
    const delay = this.status.consecutiveFailures > 0
      ? nextBackoffMs(this.status.consecutiveFailures)
      : this.deps.repo.pollIntervalSeconds * 1000
    this.timer = setTimeout(() => void this.loop(), delay)
    this.setStatus({ ...this.status, nextRunAt: Date.now() + delay })
  }

  private branchCount(): number {
    return (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM branches WHERE repo_id=?`)
      .get(this.deps.repo.id) as { n: number }).n
  }

  private setStatus(s: SchedulerStatus): void {
    this.status = s
    this.deps.handlers.onStatus(s)
  }

  async runOnce(): Promise<RunOnceResult> {
    if (this.running) return { skipped: true }
    this.running = true
    this.setStatus({ ...this.status, state: 'running' })
    const { db, repo, mirrorDir } = this.deps
    const eventId = startFetchEvent(db, repo.id)
    try {
      await ensureMirror(repo.url, mirrorDir)
      const before = await snapshotRefs(mirrorDir)
      await fetchMirror(mirrorDir)
      const after = await snapshotRefs(mirrorDir)

      let newCommits = 0
      if (this.branchCount() === 0) {
        // 设计文档 §5.4：首次全量回填，不产生新提交事件
        const heads = Object.entries(after)
          .filter(([b]) => !isBranchExcluded(b, repo.branchExclude))
          .map(([branch, sha]) => ({ branch, sha }))
        newCommits = await backfillRepo(db, repo.id, mirrorDir, heads)
      } else {
        const raw = diffRefs(before, after)
          .filter(c => !isBranchExcluded(c.branch, repo.branchExclude))
        const changes = await classifyChanges(mirrorDir, raw)
        const r = await applyChanges(db, repo.id, mirrorDir, changes)
        newCommits = r.newCommits
        for (const [branch, commits] of Object.entries(r.insertedByBranch)) {
          if (commits.length > 0) this.deps.handlers.onCommitsNew(branch, commits)
        }
        if (changes.some(c => c.type === 'added' || c.type === 'deleted' || c.type === 'force-push')) {
          this.deps.handlers.onBranchesUpdated()
        }
      }
      finishFetchEvent(db, eventId, 'ok', newCommits)
      this.setStatus({
        ...this.status, state: 'idle', lastRunAt: Date.now(),
        consecutiveFailures: 0, lastError: null, lastNewCommits: newCommits
      })
      return { skipped: false, newCommits }
    } catch (e) {
      const msg = (e as Error).message
      if (CORRUPT_RE.test(msg)) rmSync(mirrorDir, { recursive: true, force: true })  // 下一轮自动重克隆
      finishFetchEvent(db, eventId, 'failed', 0, msg)
      this.setStatus({
        ...this.status, state: 'backoff', lastRunAt: Date.now(),
        consecutiveFailures: this.status.consecutiveFailures + 1, lastError: msg
      })
      return { skipped: false, error: msg }
    } finally {
      this.running = false
    }
  }
}
