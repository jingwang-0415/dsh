import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    // GET /api/repos 契约：五个字段（branchExclude 为审查搭车项——排除 glob 需 UI 可见）
    for (const row of list.json()) {
      expect(Object.keys(row)).toEqual(['id', 'url', 'defaultBranch', 'branchExclude', 'pollIntervalSeconds'])
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

  it('POST id 为 . 或 .. → 400 且数据目录原封不动（封死 mirrorDir 逃逸删除链）', async () => {
    // 攻击链（审查 C1）：'..' 过白名单正则 → mirrorDirFor('..')=join(dataDir,'repos','..')=dataDir
    // → ensureMirror 见目录存在返回 existing → snapshotRefs 报 not a git repository
    // → 命中 CORRUPT_RE → rmSync(mirrorDir,recursive,force) = 删掉整个数据目录（db+config+全部镜像）
    for (const id of ['..', '.']) {
      const res = await handle.app.inject({ method: 'POST', url: '/api/repos', payload: { id, url: o3.dir } })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('不能为')
      })
      expect(existsSync(dataDir)).toBe(true)   // 修复前此断言点已被异步 rm -rf 掀掉
    }
  })
})

describe('DELETE 最后一个仓（configSchema repos min(1) 保底）', () => {
  let o: ReturnType<typeof createOriginRepo>
  let configPath: string
  let handle: AppHandle

  beforeAll(async () => {
    o = createOriginRepo('gsm-rm-last-')
    o.commitFile('only.txt', 'only')   // 同秒同内容 SHA 碰撞规避（multirepo 先例）
    const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-lastrepo-')))
    configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [{ id: 'only', url: o.dir }] }))
    handle = await buildApp({
      configPath,
      dataDir: trackTmp(mkdtempSync(join(tmpdir(), 'gsm-lastrepo-data-')))
    })
  })

  // 只关停：临时目录由外层 describe 的 afterAll cleanupTracked 统一清理
  afterAll(async () => { await handle.close() })

  it('DELETE 唯一仓 → 409 last_repo，config 文件未改动且 scheduler 不动', async () => {
    const before = handle.schedulers.length
    const res = await handle.app.inject({ method: 'DELETE', url: '/api/repos/only' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'last_repo', message: '至少保留一个仓库' })

    // 磁盘 repos:[] 会让重启 loadConfig 直接抛错（index.ts 顶层 await 崩溃）——必须未改动
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string }[] }
    expect(cfg.repos.map(r => r.id)).toEqual(['only'])
    expect(handle.schedulers.length).toBe(before)
    expect(handle.schedulers[0].repoId).toBe('only')
  })
})

describe('PATCH /api/repos/:id（运行时调整轮询间隔与分支属性，原位变更语义）', () => {
  let o: ReturnType<typeof createOriginRepo>
  let configPath: string
  let dataDir: string
  let handle: AppHandle

  interface RepoRow {
    id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number
  }

  beforeAll(async () => {
    o = createOriginRepo('gsm-patch-')
    o.commitFile('p.txt', 'p')   // 同秒同内容 SHA 碰撞规避（multirepo 先例）
    const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-patch-')))
    configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [{ id: 'p1', url: o.dir }] }))
    dataDir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-patch-data-')))
    handle = await buildApp({ configPath, dataDir })
  })

  // 只关停：临时目录由外层 cleanupTracked 统一清理；构建期 schedulers 不 start，无在飞写入
  afterAll(async () => { await handle.close() })

  /** 读原路径 config.json 首仓（PATCH 会原子回写该文件，断言即验证回写行为） */
  const onDiskRepo = (): RepoRow => {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: RepoRow[] }
    return cfg.repos[0]
  }

  it('PATCH 未知 id → 404 repo_not_found', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/ghost', payload: { pollIntervalSeconds: 10 }
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'repo_not_found' })
  })

  it('PATCH body 含 url → 400 url_immutable（message 断言，内存不被改动）', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { url: '/somewhere/else' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      code: 'url_immutable',
      message: 'url 不可修改，请删除后重新添加以更换地址'
    })
    expect(handle.config.repos[0].url).toBe(o.dir)
  })

  it('PATCH body 含 id → 400 url_immutable（同族：身份键一律不可 PATCH）', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { id: 'renamed' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'url_immutable' })
  })

  it('PATCH 空 body → 400 no_fields', async () => {
    const res = await handle.app.inject({ method: 'PATCH', url: '/api/repos/p1', payload: {} })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'no_fields' })
  })

  it('PATCH pollIntervalSeconds=0 / "abc" → 400 invalid，非法值不落内存', async () => {
    for (const bad of [0, 'abc']) {
      const res = await handle.app.inject({
        method: 'PATCH', url: '/api/repos/p1', payload: { pollIntervalSeconds: bad }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid' })
    }
    expect(handle.config.repos[0].pollIntervalSeconds).toBe(30)
  })

  it('PATCH 合法 → 200 新值；config 文件与 DB default_branch 同步；config.repos 中仍是原对象（原位变更锁）', async () => {
    const repoRef = handle.config.repos.find(r => r.id === 'p1')
    expect(repoRef).toBeDefined()
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1',
      payload: { pollIntervalSeconds: 7, defaultBranch: 'main', branchExclude: ['tmp/**'] }
    })
    expect(res.statusCode).toBe(200)
    // 返回形状与 GET /api/repos 行一致（四字段 + branchExclude）
    expect(res.json()).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 7
    })

    // 原位变更锁：config.repos 中仍是同一对象引用——Scheduler.deps.repo 持同引用，
    // 下一轮询周期才按新 pollIntervalSeconds 调度；整体替换对象会让此处拿到旧对象
    expect(handle.config.repos[0]).toBe(repoRef)
    expect(repoRef!.pollIntervalSeconds).toBe(7)
    expect(repoRef!.defaultBranch).toBe('main')
    expect(repoRef!.branchExclude).toEqual(['tmp/**'])
    expect(repoRef!.url).toBe(o.dir)

    // config 文件回写：新三字段 + url/id 未变
    expect(onDiskRepo()).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 7
    })

    // DB repos 行 default_branch 同步（readonly 断言）。
    // 注：repos 表无 branch_exclude 列（v1.3 schema 即如此），branchExclude 的持久层是 config.json
    const db = new Database(join(dataDir, 'monitor.db'), { readonly: true })
    try {
      const row = db.prepare(`SELECT default_branch FROM repos WHERE id='p1'`).get() as { default_branch: string }
      expect(row.default_branch).toBe('main')
    } finally { db.close() }
  })

  it('引用语义锁：PATCH 后同一仓再次 PATCH → 仍 200，只更新提供的键（防整体替换断引用回归）', async () => {
    const repoRef = handle.config.repos[0]
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { pollIntervalSeconds: 11 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: 'p1', pollIntervalSeconds: 11, defaultBranch: 'main', branchExclude: ['tmp/**']
    })
    // 若上次 PATCH 整体替换了对象，repoRef 会停在旧值——新值必须落在同一对象上
    expect(repoRef.pollIntervalSeconds).toBe(11)
    expect(handle.config.repos[0]).toBe(repoRef)

    // GET /api/repos（读 config）与磁盘文件都反映最新值
    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json()[0]).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 11
    })
    expect(onDiskRepo().pollIntervalSeconds).toBe(11)
  })
})
