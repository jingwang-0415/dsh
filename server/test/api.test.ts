import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'

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
    await handle.scheduler.runOnce()   // 首轮回填
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
    await handle.scheduler.runOnce()
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
