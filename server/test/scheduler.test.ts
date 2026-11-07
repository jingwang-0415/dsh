import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createOriginRepo } from './fixture.js'
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
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
  db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
  return db
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
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
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
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
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
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    rmSync(origin.dir, { recursive: true, force: true })   // 远端消失
    const r = await s.runOnce()
    expect('error' in r).toBe(true)
    expect(s.status.consecutiveFailures).toBe(1)
    expect(['backoff', 'error']).toContain(s.status.state)
    const ev = db.prepare(`SELECT status, error FROM fetch_events ORDER BY id DESC LIMIT 1`).get() as { status: string; error: string | null }
    expect(ev.status).toBe('failed')
    expect(ev.error).not.toBeNull()
    db.close()
  })

  it('镜像损坏后自愈（重克隆）', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    rmSync(join(mirrorDir, 'HEAD'))   // 破坏镜像
    await s.runOnce()                  // 失败并删除镜像
    const r = await s.runOnce()        // 重克隆 + 空差异，不再回填（branches 已有行）
    expect('error' in r).toBe(false)
    expect(s.status.state).toBe('idle')
    db.close()
  })

  it('运行中重入直接跳过', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    // @ts-expect-error 直接操纵私有标志模拟运行中
    s.running = true
    const r = await s.runOnce()
    expect(r.skipped).toBe(true)
    // @ts-expect-error 恢复
    s.running = false
    db.close()
  })
})
