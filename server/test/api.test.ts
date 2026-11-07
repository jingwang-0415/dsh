import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createOriginRepo } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

describe('API 集成（真实 git fixture）', () => {
  let origin: ReturnType<typeof createOriginRepo>
  let handle: AppHandle
  let fixSha: string

  beforeAll(async () => {
    origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.git(['checkout', 'master'])
    fixSha = origin.commitFile('fix.txt', 'fix')

    handle = await buildApp({
      configOverride: {
        repos: [{ id: 'demo', url: origin.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
        server: { host: '127.0.0.1', port: 43900 }
      },
      dataDir: mkdtempSync(join(tmpdir(), 'gsm-data-'))
    })
    await handle.schedulers[0].runOnce()   // 首轮回填
  })

  afterAll(async () => { await handle.close() })

  it('GET /api/status 暴露调度状态与镜像路径', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe('idle')
    expect(body.mirrorDir).toContain(join('repos', 'demo'))
    expect(body.lastFetch.status).toBe('ok')
  })

  it('GET /api/repos 返回配置仓库', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(res.json()).toMatchObject([{ id: 'demo', defaultBranch: 'master', url: origin.dir }])
  })

  it('GET /api/branches 返回两个分支含提交信息', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/branches' })
    const rows = res.json()
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(['master', 'release/1.0'])
    const master = rows.find((r: { name: string }) => r.name === 'master')
    expect(master.headSha).toBeTruthy()
    expect(master.lastSubject).toBe('add fix.txt')
    expect(master.recentCommits).toBeGreaterThanOrEqual(0)
  })

  it('GET /api/commits?branch= 分页返回提交', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=10' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)  // fixture README + fix.txt
  })

  it('GET /api/commits limit=abc 返回 400（NaN 会绕过 --max-count 触发全量 rev-list）', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=abc' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('GET /api/commits limit=0 返回 400（无界 rev-list 防线）', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=0' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('GET /api/commits limit=-1 返回 400（不再伪装成 404）', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=-1' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('GET /api/commits limit=1 返回 200 且恰 1 行', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=1' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })

  it('GET /api/commits 非法 offset 返回 400，合法 offset 生效', async () => {
    const bad = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&offset=abc' })
    expect(bad.statusCode).toBe(400)
    const neg = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&offset=-1' })
    expect(neg.statusCode).toBe(400)
    const ok = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&offset=1&limit=1' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toHaveLength(1)
  })

  it('buildApp 幂等登记 repos：同 id 改 URL 走 upsert 且 created_at 保留', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gsm-upsert-'))
    const mkHandle = (url: string): Promise<AppHandle> => buildApp({
      configOverride: {
        repos: [{ id: 'upsert-demo', url, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
        server: { host: '127.0.0.1', port: 0 }
      },
      dataDir
    })
    const readRow = (): { url: string; default_branch: string | null; created_at: number } => {
      const db = new Database(join(dataDir, 'monitor.db'), { readonly: true })
      try {
        return db.prepare(`SELECT url, default_branch, created_at FROM repos WHERE id='upsert-demo'`).get() as
          { url: string; default_branch: string | null; created_at: number }
      } finally { db.close() }
    }
    const h1 = await mkHandle(origin.dir)
    let firstCreatedAt = 0
    try {
      const first = readRow()
      expect(first.url).toBe(origin.dir)
      firstCreatedAt = first.created_at
      await new Promise(r => setTimeout(r, 5))   // 保证两次 Date.now() 可区分
    } finally { await h1.close() }
    const h2 = await mkHandle('/tmp/changed-url.git')
    try {
      const second = readRow()
      expect(second.url).toBe('/tmp/changed-url.git')   // 同 id 改 URL 被更新
      expect(second.default_branch).toBe('master')
      expect(second.created_at).toBe(firstCreatedAt)    // created_at 保留原值
    } finally { await h2.close() }
  })

  it('GET /api/compare 返回 ahead/behind 与独有提交', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/compare?base=master&target=release/1.0' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ahead).toBe(1)            // master 独有 fix.txt
    expect(body.behind).toBe(0)           // release/1.0 无独有提交
    expect(body.aheadCommits).toHaveLength(1)
    expect(body.aheadCommits[0].sha).toBe(fixSha)
    expect(body.aheadCommits[0].subject).toBe('add fix.txt')
    expect(body.behindCommits).toEqual([])
  })

  it('GET /api/compare 缺参数返回 400', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/compare?base=master' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'bad_request' })
  })

  it('GET /api/compare 未知分支返回 404', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/compare?base=master&target=nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'branch_not_found' })
  })

  it('GET /api/commits/:sha 返回详情与空 meta', async () => {
    const res = await handle.app.inject({ method: 'GET', url: `/api/commits/${fixSha}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sha).toBe(fixSha)
    expect(body.authorName).toBe('Tester')
    expect(body.authorEmail).toBe('tester@example.com')
    expect(body.subject).toBe('add fix.txt')
    expect(body.meta).toEqual({})         // nullAdapter 未注入 enrichCommit
  })

  it('GET /api/commits 相关错误路径（未知 sha 404 / 缺 branch 400 / 未知分支 404）', async () => {
    const miss = await handle.app.inject({ method: 'GET', url: `/api/commits/${'f'.repeat(40)}` })
    expect(miss.statusCode).toBe(404)
    expect(miss.json()).toMatchObject({ code: 'commit_not_found' })

    const noBranch = await handle.app.inject({ method: 'GET', url: '/api/commits' })
    expect(noBranch.statusCode).toBe(400)
    expect(noBranch.json()).toMatchObject({ code: 'bad_request' })

    const badBranch = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=nope' })
    expect(badBranch.statusCode).toBe(404)
    expect(badBranch.json()).toMatchObject({ code: 'branch_not_found' })
  })

  it('GET /api/commits/:sha/inclusion 未包含在前且状态正确', async () => {
    // fixture：release/1.0 自 fixSha 提交之前的 master 分出 → 不包含 fixSha；master 包含
    origin.commitFile('next.txt', 'n')                     // master 新提交
    await handle.schedulers[0].runOnce()
    const res = await handle.app.inject({ method: 'GET', url: `/api/commits/${fixSha}/inclusion` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.commit.sha).toBe(fixSha)
    const byName = Object.fromEntries(
      body.results.map((r: { branch: string; contains: boolean }) => [r.branch, r.contains])
    )
    expect(byName['master']).toBe(true)
    expect(byName['release/1.0']).toBe(false)
    expect(body.results[0]).toMatchObject({ branch: 'release/1.0', contains: false })  // 未包含排序在前
  })
})

describe('跨仓对比 API（真实 git fixture，两仓独立历史）', () => {
  let o1: ReturnType<typeof createOriginRepo>
  let o2: ReturnType<typeof createOriginRepo>
  let handle: AppHandle

  beforeAll(async () => {
    o1 = createOriginRepo('gsm-cr1-')
    o2 = createOriginRepo('gsm-cr2-')
    // 两个 fixture 同秒创建的首个提交内容/作者/信息相同 → SHA 字节级相同；
    // 各补一个不同内容提交使两仓历史确定性区分（既定先例，见 multirepo.test.ts）
    o1.commitFile('r1.txt', '1')
    o2.commitFile('r2.txt', '2')
    const cfg: AppConfig = {
      repos: [
        { id: 'r1', url: o1.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
        { id: 'r2', url: o2.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }
      ],
      server: { host: '127.0.0.1', port: 43900 }
    }
    handle = await buildApp({ configOverride: cfg, dataDir: mkdtempSync(join(tmpdir(), 'gsm-cr-data-')) })
    for (const s of handle.schedulers) await s.runOnce()   // 首轮回填两仓
  })

  afterAll(async () => { await handle.close() })

  it('crossrepo/branches 同名配对与未配对', async () => {
    o1.git(['checkout', '-b', 'dev'])           // r1 多一个 dev
    o1.git(['checkout', 'master'])
    for (const s of handle.schedulers) await s.runOnce()   // dev 需回填入库才会出现在 branches 结果
    const res = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/branches?repoA=r1&repoB=r2' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.paired).toEqual(['master'])
    expect(body.unpairedA).toEqual(['dev'])
    expect(body.unpairedB).toEqual([])
  })

  it('crossrepo/compare 同补丁跨仓命中 + 404/400 契约', async () => {
    // 两仓 master 各自打上同一补丁（不同 SHA）
    const mark = (repo: ReturnType<typeof createOriginRepo>) => repo.commitFile('same-fix.txt', 'identical\n')
    mark(o1); mark(o2)
    for (const s of handle.schedulers) await s.runOnce()
    const res = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=r1&repoB=r2&branchA=master&branchB=master' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.matchedPairs.some((p: { subjectA: string }) => p.subjectA === 'add same-fix.txt')).toBe(true)
    const nf = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=nope&repoB=r2&branchA=master&branchB=master' })
    expect(nf.statusCode).toBe(404)
    const miss = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=r1&repoB=r2' })
    expect(miss.statusCode).toBe(400)
    const badBranch = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=r1&repoB=r2&branchA=nope&branchB=master' })
    expect(badBranch.statusCode).toBe(404)
    expect(badBranch.json()).toMatchObject({ code: 'branch_not_found' })
  })

  it('crossrepo/compare exclude 生效：仅 vendor 改动的提交不进 onlyInA/onlyInB', async () => {
    // fixture commitFile 为裸 writeFileSync，子目录需先创建（探针实证：ENOENT）
    mkdirSync(join(o1.dir, 'vendor'), { recursive: true })
    const shaA = o1.commitFile('vendor/v.txt', 'v-a')
    mkdirSync(join(o2.dir, 'vendor'), { recursive: true })
    const shaB = o2.commitFile('vendor/v.txt', 'v-b')
    for (const s of handle.schedulers) await s.runOnce()
    const res = await handle.app.inject({
      method: 'GET',
      url: '/api/crossrepo/compare?repoA=r1&repoB=r2&branchA=master&branchB=master&exclude=vendor%2F**'
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.onlyInA.map((c: { sha: string }) => c.sha)).not.toContain(shaA)
    expect(body.onlyInB.map((c: { sha: string }) => c.sha)).not.toContain(shaB)
  })
})
