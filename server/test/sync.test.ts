import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror, fetchMirror } from '../src/mirror.js'
import { openDb } from '../src/db.js'
import { applyChanges, backfillRepo, finishFetchEvent, insertCommits, startFetchEvent } from '../src/sync.js'
import { listCommits } from '../src/sync.js'
import { diffRefs, classifyChanges } from '../src/refDiff.js'
import { snapshotRefs } from '../src/mirror.js'
import type Database from 'better-sqlite3'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}
function count(db: Database.Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n
}

describe('sync（真实 git fixture）', () => {
  it('backfillRepo 全量入库且分支建行', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.commitFile('r.txt', 'r1')
    origin.git(['checkout', 'master'])
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()

    const snap = await snapshotRefs(mirrorDir)
    const heads = Object.entries(snap).map(([branch, sha]) => ({ branch, sha }))
    const total = await backfillRepo(db, 'r', mirrorDir, heads)
    expect(total).toBe(2)
    expect(count(db, `SELECT COUNT(*) AS n FROM branches WHERE repo_id='r'`)).toBe(2)
    db.close()
  })

  it('fast-forward 增量只插入新提交', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
    await backfillRepo(db, 'r', mirrorDir, [{ branch: 'master', sha: headSha(origin.dir) }])

    const oldSha = headSha(origin.dir)
    origin.commitFile('n.txt', 'new')
    await fetchMirror(mirrorDir) // 调度器真实流程：先 fetch 再 diff/classify/apply
    const newSha = headSha(origin.dir)
    const changes = await classifyChanges(mirrorDir, diffRefs({ master: oldSha }, { master: newSha }))
    const r = await applyChanges(db, 'r', mirrorDir, changes)
    expect(r.newCommits).toBe(1)
    expect(r.insertedByBranch['master']).toHaveLength(1)
    expect(count(db, `SELECT COUNT(*) AS n FROM commits WHERE repo_id='r'`)).toBe(2)
    db.close()
  })

  it('force-push 更新 head 并标记 rewritten；deleted 标记状态', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
    await backfillRepo(db, 'r', mirrorDir, [{ branch: 'master', sha: headSha(origin.dir) }])

    const oldSha = headSha(origin.dir)
    // 固定 author 日期：同秒内 amend 且无变更会产生完全相同的提交对象（SHA 不变），导致历史重写未发生
    origin.git(['commit', '--amend', '--no-edit', '--allow-empty', '--date=2005-04-07T22:13:13 +0000'])
    const amended = headSha(origin.dir)
    await fetchMirror(mirrorDir) // 调度器真实流程：先 fetch 再 diff/classify/apply
    const changes = await classifyChanges(mirrorDir, diffRefs({ master: oldSha }, { master: amended }))
    await applyChanges(db, 'r', mirrorDir, changes)
    const row = db.prepare(`SELECT head_sha, rewritten_at FROM branches WHERE repo_id='r' AND name='master'`).get() as { head_sha: string; rewritten_at: number | null }
    expect(row.head_sha).toBe(amended)
    expect(row.rewritten_at).not.toBeNull()

    const evId = startFetchEvent(db, 'r')
    finishFetchEvent(db, evId, 'ok', 0)
    expect((db.prepare(`SELECT status FROM fetch_events WHERE id=?`).get(evId) as { status: string }).status).toBe('ok')

    await applyChanges(db, 'r', mirrorDir, [{ type: 'deleted', branch: 'master', oldSha: amended }])
    expect((db.prepare(`SELECT status FROM branches WHERE repo_id='r' AND name='master'`).get() as { status: string }).status).toBe('deleted')
    db.close()
  })

  it('listCommits 支持 maxCount/skip 且 insertCommits 幂等', async () => {
    const origin = createOriginRepo()
    origin.commitFile('a.txt', '1')
    origin.commitFile('b.txt', '2')
    origin.commitFile('c.txt', '3')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()

    const page = await listCommits(mirrorDir, 'refs/heads/master', { maxCount: 2 })
    expect(page).toHaveLength(2)
    const all = await listCommits(mirrorDir, 'refs/heads/master')
    expect(all).toHaveLength(4) // fixture 初始 README 提交 + 3
    const again = insertCommits(db, 'r', 'master', all)
    expect(again).toHaveLength(4)
    expect(insertCommits(db, 'r', 'master', all)).toHaveLength(0) // 幂等
    db.close()
  })
})
