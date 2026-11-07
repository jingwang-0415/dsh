import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'

describe('openDb', () => {
  it('建库并创建全部表', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name)
    for (const t of ['repos', 'branches', 'commits', 'fetch_events']) expect(tables).toContain(t)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    db.close()
  })

  it('commits 与 branches 唯一约束生效', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'u', 1)`).run()
    db.prepare(`INSERT INTO branches (repo_id, name, created_at, updated_at) VALUES ('r', 'master', 1, 1)`).run()
    expect(() => db.prepare(`INSERT INTO branches (repo_id, name, created_at, updated_at) VALUES ('r', 'master', 2, 2)`).run()).toThrow(/UNIQUE/)
    db.prepare(`INSERT INTO commits (repo_id, sha, committed_at, first_seen_at) VALUES ('r', 'abc', 1, 1)`).run()
    expect(() => db.prepare(`INSERT INTO commits (repo_id, sha, committed_at, first_seen_at) VALUES ('r', 'abc', 2, 2)`).run()).toThrow(/UNIQUE/)
    db.close()
  })
})
