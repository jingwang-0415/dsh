import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

describe('多仓调度与 repo 作用域（真实 git）', () => {
  let o1: ReturnType<typeof createOriginRepo>
  let o2: ReturnType<typeof createOriginRepo>
  let handle: AppHandle

  beforeAll(async () => {
    o1 = createOriginRepo('gsm-mr1-')
    o2 = createOriginRepo('gsm-mr2-')
    // 两个 fixture 的首个提交（内容/作者/信息相同，同一秒内创建）会产生完全相同的 SHA，
    // 使下方 headSha 不相等断言必然失败；各补一个不同内容提交以确定性区分两仓 HEAD
    o1.commitFile('r1.txt', '1')
    o2.commitFile('r2.txt', '2')
    const cfg: AppConfig = {
      repos: [
        { id: 'r1', url: o1.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
        { id: 'r2', url: o2.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }
      ],
      server: { host: '127.0.0.1', port: 43900 }
    }
    handle = await buildApp({ configOverride: cfg, dataDir: trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mr-data-'))) })
    for (const s of handle.schedulers) await s.runOnce()
  })

  afterAll(async () => { await handle.close(); cleanupTracked() })   // 目录在 beforeAll 建、文件级共享：关停后统一清理

  // v1.4 测试卫生：spy 恢复收敛到 afterEach——用例中途断言失败也不泄漏 mock（原内联
  // mockRestore 只在用例 happy path 尾部执行）；restoreAllMocks 覆盖本文件全部 vi.spyOn
  afterEach(() => { vi.restoreAllMocks() })

  it('两个 scheduler 各自回填各自的仓', async () => {
    const r1 = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=r1' })
    const r2 = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=r2' })
    expect(r1.json().map((b: { name: string }) => b.name)).toEqual(['master'])
    expect(r2.json().map((b: { name: string }) => b.name)).toEqual(['master'])
    expect(r1.json()[0].headSha).not.toBe(r2.json()[0].headSha)
  })

  it('缺省 repo = 第一个仓；未知 repo → 404 repo_not_found', async () => {
    const dflt = await handle.app.inject({ method: 'GET', url: '/api/branches' })
    expect(dflt.json()[0].headSha).toMatch(/^[0-9a-f]{40}$/)
    const nf = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=nope' })
    expect(nf.statusCode).toBe(404)
    expect(nf.json().code).toBe('repo_not_found')
  })

  it('r2 新提交只被 r2 的 scheduler 检出（repoId 正确）', async () => {
    o2.commitFile('only2.txt', 'x')
    const s2 = handle.schedulers[1]
    const r = await s2.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(1)
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?repo=r2&branch=master' })
    expect(res.json().map((c: { subject: string }) => c.subject)).toContain('add only2.txt')
    const r1res = await handle.app.inject({ method: 'GET', url: '/api/commits?repo=r1&branch=master' })
    expect(r1res.json().map((c: { subject: string }) => c.subject)).not.toContain('add only2.txt')
  })

  it('/api/status?repo= 返回对应仓状态', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/status?repo=r2' })
    expect(res.statusCode).toBe(200)
    expect(res.json().mirrorDir).toContain(join('repos', 'r2'))
    expect(res.json().repoId).toBe('r2')
  })

  it('SSE 三类事件载荷都带正确 repoId（commits.new/branches.updated/status.changed 契约）', async () => {
    const publish = vi.spyOn(handle.sse, 'publish')
    o2.git(['checkout', '-b', 'newfeat'])
    // 内容与既有对象不同，规避同秒同内容提交 SHA 碰撞（仓库既定经验）
    o2.commitFile('newfeat.txt', 'newfeat-content\n')
    await handle.schedulers[1].runOnce()
    const calls = publish.mock.calls
    const commitsNew = calls.filter(([e]) => e === 'commits.new').map(([, d]) => d as { repoId: string; branch: string })
    expect(commitsNew).toContainEqual(expect.objectContaining({ repoId: 'r2', branch: 'newfeat' }))
    const branchesUpdated = calls.filter(([e]) => e === 'branches.updated').map(([, d]) => d as { repoId: string })
    expect(branchesUpdated).toContainEqual(expect.objectContaining({ repoId: 'r2' }))
    // status.changed 可能多次（running/idle），取 repoId==='r2' 且 state==='idle' 的记录断言
    const statusIdle = calls.filter(
      ([e, d]) => e === 'status.changed' && (d as { repoId?: string }).repoId === 'r2' && (d as { state?: string }).state === 'idle'
    )
    expect(statusIdle.length).toBeGreaterThan(0)
  })   // publish spy 恢复由 afterEach 统一收敛
})
