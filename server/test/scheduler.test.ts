import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'

afterEach(cleanupTracked)
import { openDb } from '../src/db.js'
import { Scheduler, nextBackoffMs } from '../src/scheduler.js'
import type { CommitInfo } from '../src/parse.js'
import type Database from 'better-sqlite3'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}
function makeScheduler(db: Database.Database, repoUrl: string, mirrorDir: string) {
  const onCommitsNew = vi.fn()
  const onBranchesUpdated = vi.fn()
  const onStatus = vi.fn()
  const s = new Scheduler({
    db,
    repo: { id: 'r', url: repoUrl, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
    mirrorDir,
    handlers: { onCommitsNew, onBranchesUpdated, onStatus }
  })
  return { s, onCommitsNew, onBranchesUpdated, onStatus }
}
function setupDb(): Database.Database {
  const db = openDb(join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-db-'))), 'monitor.db'))
  db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
  return db
}
function countRows(db: Database.Database, table: 'branches' | 'commits'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('nextBackoffMs', () => {
  it('指数退避并封顶 5 分钟', () => {
    expect(nextBackoffMs(1)).toBe(5000)
    expect(nextBackoffMs(2)).toBe(10000)
    expect(nextBackoffMs(5)).toBe(80000)
    expect(nextBackoffMs(20)).toBe(300000)
  })
})

describe('Scheduler.runOnce（真实 git fixture）', () => {
  it('首次运行全量回填且不触发 onCommitsNew', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'rel'])
    origin.commitFile('r.txt', '1')
    origin.git(['checkout', 'master'])
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s, onCommitsNew } = makeScheduler(db, origin.dir, mirrorDir)
    const r = await s.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(2)
    expect(onCommitsNew).not.toHaveBeenCalled()
    expect(s.status.state).toBe('idle')
    db.close()
  })

  it('新提交触发增量与 onCommitsNew', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s, onCommitsNew } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    origin.commitFile('new.txt', 'n')
    const r = await s.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(1)
    expect(onCommitsNew).toHaveBeenCalledTimes(1)
    expect(onCommitsNew.mock.calls[0][0]).toBe('master')
    expect((onCommitsNew.mock.calls[0][1] as CommitInfo[])[0].sha).toBe(headSha(origin.dir))
    db.close()
  })

  it('远端不可达进入退避并记录 fetch_events=failed', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    rmSync(origin.dir, { recursive: true, force: true })   // 远端消失
    const r = await s.runOnce()
    expect('error' in r).toBe(true)
    expect(s.status.consecutiveFailures).toBe(1)
    expect(s.status.state).toBe('backoff')
    const ev = db.prepare(`SELECT status, error FROM fetch_events ORDER BY id DESC LIMIT 1`).get() as { status: string; error: string | null }
    expect(ev.status).toBe('failed')
    expect(ev.error).not.toBeNull()
    db.close()
  })

  it('镜像损坏后自愈：重克隆并按 spec §11 全量回填（幂等无重复）', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()
    const baseBranches = countRows(db, 'branches')
    const baseCommits = countRows(db, 'commits')

    rmSync(join(mirrorDir, 'HEAD'))   // 破坏镜像
    await s.runOnce()                 // 失败并删除镜像
    const r = await s.runOnce()       // 重克隆 → spec §11：必须全量回填，而非依赖恒空的 diff
    expect('error' in r).toBe(false)
    expect(s.status.state).toBe('idle')
    expect(countRows(db, 'branches')).toBe(baseBranches)
    expect(countRows(db, 'commits')).toBe(baseCommits)
    const dup = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT sha FROM commits GROUP BY sha HAVING COUNT(*) > 1)`).get() as { n: number }
    expect(dup.n).toBe(0)
    db.close()
  })

  it('损坏窗口期间上游新增分支：重克隆后回填补齐（spec §11）', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()
    expect(countRows(db, 'branches')).toBe(1)

    rmSync(join(mirrorDir, 'HEAD'))                    // 破坏镜像
    origin.git(['checkout', '-b', 'feature/late'])     // 损坏窗口期间上游新增分支与提交
    const lateSha = origin.commitFile('late.txt', 'L')
    origin.git(['checkout', 'master'])
    await s.runOnce()                                  // 失败并删除镜像
    const r = await s.runOnce()                        // 重克隆 → 全量回填补齐窗口期数据
    expect('error' in r).toBe(false)
    expect('newCommits' in r && r.newCommits).toBe(1)  // 仅窗口期的 late 提交为新增

    const names = (db.prepare(`SELECT name FROM branches WHERE repo_id='r' ORDER BY name`).all() as { name: string }[])
      .map(b => b.name)
    expect(names).toEqual(['feature/late', 'master'])
    const late = db.prepare(`SELECT head_sha, status FROM branches WHERE repo_id='r' AND name='feature/late'`).get() as { head_sha: string; status: string }
    expect(late.head_sha).toBe(lateSha)
    expect(late.status).toBe('active')
    expect(countRows(db, 'commits')).toBe(2)           // 基线 README（幂等忽略）+ late
    const dup = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT sha FROM commits GROUP BY sha HAVING COUNT(*) > 1)`).get() as { n: number }
    expect(dup.n).toBe(0)
    db.close()
  })

  it('运行中重入直接跳过', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    // @ts-expect-error 直接操纵私有标志模拟运行中
    s.running = true
    const r = await s.runOnce()
    expect(r.skipped).toBe(true)
    // @ts-expect-error 恢复
    s.running = false
    db.close()
  })

  it('stop 后 loop 早退：不产生 fetch_events 也不触发 onStatus', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const { s, onStatus } = makeScheduler(db, origin.dir, mirrorDir)
    s.stop()
    await (s as any).loop()
    const n = db.prepare(`SELECT COUNT(*) AS n FROM fetch_events`).get() as { n: number }
    expect(n.n).toBe(0)
    expect(onStatus).not.toHaveBeenCalled()
    s.stop()   // 清理：若实现已排程 timer 则清除
    db.close()
  })

  it('loop 内 onStatus 抛错不 reject 且 timer 已排程', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const onStatus = vi.fn(() => { throw new Error('socket destroyed') })
    const s = new Scheduler({
      db,
      repo: { id: 'r', url: origin.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
      mirrorDir,
      handlers: { onCommitsNew: vi.fn(), onBranchesUpdated: vi.fn(), onStatus }
    })
    // 修复前：loop 尾部 setStatus 抛错经 void this.loop() 变 unhandledRejection
    await expect((s as unknown as { loop(): Promise<void> }).loop()).resolves.toBeUndefined()
    expect(onStatus).toHaveBeenCalled()
    expect(s.status.nextRunAt).not.toBeNull()   // 已排程的 timer 不受回调失败影响
    s.stop()   // 清理排程的 timer
    db.close()
  })

  it('onStatus 抛错不 reject 且不卡死互斥', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    const onCommitsNew = vi.fn()
    const onBranchesUpdated = vi.fn()
    const onStatus = vi.fn(() => { throw new Error('socket destroyed') })
    const s = new Scheduler({
      db,
      repo: { id: 'r', url: origin.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
      mirrorDir,
      handlers: { onCommitsNew, onBranchesUpdated, onStatus }
    })
    const r = await s.runOnce()          // 应 fulfilled：catch 内故障被兜底，不外抛
    expect('error' in r).toBe(true)
    expect(r.skipped).toBe(false)
    const r2 = await s.runOnce()         // running 已被 finally 释放 → 不得 skipped
    expect(r2.skipped).toBe(false)
    db.close()
  })
})
