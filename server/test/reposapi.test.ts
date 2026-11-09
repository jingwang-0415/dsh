import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'

/**
 * v1.3 Task 1：仓库生命周期 API（POST/DELETE /api/repos）。
 * 走真实 config.json（非 configOverride）：POST/DELETE 会原子回写该文件，
 * 断言"读原路径 JSON 含/不含新仓"即验证回写行为。
 */

describe('仓库生命周期 API（真实 config 文件 fixture）', () => {
  let o1: ReturnType<typeof createOriginRepo>
  let o2: ReturnType<typeof createOriginRepo>
  let o3: ReturnType<typeof createOriginRepo>
  let configPath: string
  let dataDir: string
  let handle: AppHandle

  beforeAll(async () => {
    o1 = createOriginRepo('gsm-rm1-')
    o2 = createOriginRepo('gsm-rm2-')
    o3 = createOriginRepo('gsm-rm3-')
    // 同秒创建的同内容首提交 SHA 字节级相同 → 各仓补一个不同内容提交（既定先例，见 multirepo.test.ts）
    o1.commitFile('r1.txt', '1')
    o2.commitFile('r2.txt', '2')
    o3.commitFile('r3.txt', '3')

    const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-reposapi-')))
    configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      repos: [
        { id: 'r1', url: o1.dir },
        { id: 'r2', url: o2.dir }
      ]
    }))
    dataDir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-reposapi-data-')))
    handle = await buildApp({ configPath, dataDir })
  })

  afterAll(async () => { await handle.close(); cleanupTracked() })

  /** 等首轮 runOnce 落定（addScheduler 已 start）：避免 close 时仍在飞行写 DB */
  async function awaitSettled(id: string): Promise<string> {
    const sched = handle.schedulers.find(s => s.repoId === id)
    expect(sched).toBeDefined()
    let state = sched!.status.state
    for (let i = 0; i < 100 && (state === 'starting' || state === 'running'); i++) {
      await new Promise(r => setTimeout(r, 20))
      state = sched!.status.state
    }
    return state
  }

  const onDiskRepoIds = (): string[] => {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string }[] }
    return cfg.repos.map(r => r.id)
  }

  it('POST 合法仓 → 201，列表/调度器/状态可查且 config 文件被原子回写', async () => {
    const before = handle.schedulers.length
    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'beta', url: o3.dir }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      id: 'beta', url: o3.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30
    })
    expect(handle.configPath).toBe(configPath)

    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json().map((r: { id: string }) => r.id)).toEqual(['r1', 'r2', 'beta'])
    // GET /api/repos 契约不变：仍只暴露这四个字段
    for (const row of list.json()) {
      expect(Object.keys(row)).toEqual(['id', 'url', 'defaultBranch', 'pollIntervalSeconds'])
    }
    expect(handle.schedulers.length).toBe(before + 1)

    const status = await handle.app.inject({ method: 'GET', url: '/api/status?repo=beta' })
    expect(status.statusCode).toBe(200)
    expect(status.json().repoId).toBe('beta')

    expect(await awaitSettled('beta')).toBe('idle')   // 免重启：新仓真跑了一轮同步

    expect(onDiskRepoIds()).toEqual(['r1', 'r2', 'beta'])   // config 文件被回写且含默认值填充
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string; defaultBranch: string }[] }
    expect(cfg.repos[2]).toMatchObject({ id: 'beta', defaultBranch: 'master', pollIntervalSeconds: 30 })
  })

  it('POST 重复 id → 409 repo_exists（内存与调度器不受影响）', async () => {
    const before = handle.schedulers.length
    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'r1', url: o1.dir }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'repo_exists' })
    expect(handle.schedulers.length).toBe(before)
  })

  it('POST 非法 id（../ 与空格）→ 400 且消息含白名单文案', async () => {
    for (const id of ['../evil', 'a b']) {
      const res = await handle.app.inject({
        method: 'POST', url: '/api/repos', payload: { id, url: o3.dir }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('id 仅允许字母数字与 . _ -')
      })
    }
  })

  it('POST 空 url → 400 invalid', async () => {
    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'good-id', url: '' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid' })
  })

  it('DELETE 已知仓 → ok，列表/调度器移除、config 文件已移除、DB 行与历史保留', async () => {
    await awaitSettled('beta')   // 等首跑落定再删，close 时无在飞 runOnce
    const before = handle.schedulers.length
    const res = await handle.app.inject({ method: 'DELETE', url: '/api/repos/beta' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })

    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json().map((r: { id: string }) => r.id)).toEqual(['r1', 'r2'])
    expect(handle.schedulers.length).toBe(before - 1)
    expect(handle.schedulers.some(s => s.repoId === 'beta')).toBe(false)
    expect(onDiskRepoIds()).toEqual(['r1', 'r2'])   // config 文件已移除该仓

    const gone = await handle.app.inject({ method: 'GET', url: '/api/status?repo=beta' })
    expect(gone.statusCode).toBe(404)
    expect(gone.json()).toMatchObject({ code: 'repo_not_found' })

    // 删除只摘调度与配置：DB repos 行与 branches/commits 历史保留（同 id 重挂时接续）
    const db = new Database(join(dataDir, 'monitor.db'), { readonly: true })
    try {
      const row = db.prepare(`SELECT id, url FROM repos WHERE id='beta'`).get() as { id: string; url: string } | undefined
      expect(row).toMatchObject({ id: 'beta', url: o3.dir })
      const branches = db.prepare(`SELECT COUNT(*) AS n FROM branches WHERE repo_id='beta'`).get() as { n: number }
      expect(branches.n).toBeGreaterThan(0)
    } finally { db.close() }
  })

  it('DELETE 未知 id → 404 repo_not_found', async () => {
    const res = await handle.app.inject({ method: 'DELETE', url: '/api/repos/ghost' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'repo_not_found' })
  })
})
