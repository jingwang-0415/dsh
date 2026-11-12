import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // 只关停：临时目录由文件级 afterAll cleanupTracked 统一清理（本文件末尾，close 先行）
  afterAll(async () => { await handle.close() })

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
    // GET /api/repos 契约（fix round 1，v1.5 扩八字段）：基础六键恒在（含 branchExclude 与
    // bypassGitConfig default false）；httpProxy/gitConfigPath 仅显式设置时出现——
    // undefined → JSON 省键（未设=跟随系统 git 配置 / 使用机器级全局配置）
    for (const row of list.json()) {
      expect(Object.keys(row).filter(k => k !== 'httpProxy' && k !== 'gitConfigPath')).toEqual([
        'id', 'url', 'defaultBranch', 'branchExclude', 'pollIntervalSeconds', 'bypassGitConfig'
      ])
      expect('httpProxy' in row).toBe(row.httpProxy !== undefined)
      expect('gitConfigPath' in row).toBe(row.gitConfigPath !== undefined)
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

  it('POST 带 bypassGitConfig/httpProxy → 201/GET/磁盘回显；PATCH 仅改 httpProxy → 新值反映、bypass 保持', async () => {
    // v1.3.2 Task 1 往返契约：传输兜底两字段走 POST 校验（repoSchema safeParse 自动收）、
    // GET 行映射、PATCH 原位变更与 config.json 回写全链路
    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos',
      payload: { id: 'gamma', url: o3.dir, bypassGitConfig: true, httpProxy: '/x' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 'gamma', bypassGitConfig: true, httpProxy: '/x' })

    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json().find((r: { id: string }) => r.id === 'gamma'))
      .toMatchObject({ bypassGitConfig: true, httpProxy: '/x' })

    // 磁盘 config.json 回写含显式值（loadConfig/repoSchema 不改写显式值）
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      repos: { id: string; bypassGitConfig: boolean; httpProxy: string }[]
    }
    expect(cfg.repos.find(r => r.id === 'gamma')).toMatchObject({ bypassGitConfig: true, httpProxy: '/x' })

    await awaitSettled('gamma')
    // PATCH 仅改 httpProxy：bypassGitConfig 保持 true，新值回显（原位共享对象 → 下一 fetch 周期生效）
    const repoRef = handle.config.repos.find(r => r.id === 'gamma')
    const patch = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/gamma', payload: { httpProxy: '' }
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({ id: 'gamma', bypassGitConfig: true, httpProxy: '' })
    expect(handle.config.repos.find(r => r.id === 'gamma')).toBe(repoRef)   // 原位变更锁
    const list2 = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list2.json().find((r: { id: string }) => r.id === 'gamma'))
      .toMatchObject({ bypassGitConfig: true, httpProxy: '' })

    // 清理：摘掉 gamma，等首跑落定再删（close 时无在飞 runOnce）
    const del = await handle.app.inject({ method: 'DELETE', url: '/api/repos/gamma' })
    expect(del.statusCode).toBe(200)
  })

  it('POST 未设 httpProxy → 201/GET 省键（未设=跟随系统）；POST 显式 \'\' → 回显空串（强制无代理）', async () => {
    // fix round 1 三分支语义经 API 全链路：
    // 1) 未设：POST body 不带 httpProxy → 响应/GET 行/config.json 均省键（存量语义）
    const bare = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'delta', url: o3.dir }
    })
    expect(bare.statusCode).toBe(201)
    expect('httpProxy' in bare.json()).toBe(false)
    expect(bare.json().bypassGitConfig).toBe(false)   // opt-in 字段 default false 显式存在

    // 2) 显式空串：键存在且值为 '' —— 强制无代理语义经 API 可达
    const forced = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'epsilon', url: o3.dir, httpProxy: '' }
    })
    expect(forced.statusCode).toBe(201)
    expect(forced.json()).toMatchObject({ id: 'epsilon', httpProxy: '' })

    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect('httpProxy' in list.json().find((r: { id: string }) => r.id === 'delta')).toBe(false)
    expect(list.json().find((r: { id: string }) => r.id === 'epsilon')).toMatchObject({ httpProxy: '' })
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string }[] }
    expect('httpProxy' in cfg.repos.find(r => r.id === 'delta')!).toBe(false)
    expect('httpProxy' in cfg.repos.find(r => r.id === 'epsilon')!).toBe(true)

    // 清理：等首跑落定再删（close 时无在飞 runOnce）
    await awaitSettled('delta')
    await awaitSettled('epsilon')
    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/delta' })).statusCode).toBe(200)
    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/epsilon' })).statusCode).toBe(200)
  })

  // —— v1.5 Task 1：按仓指定 git 配置文件（POST/PATCH/GET 全链路）——

  it('POST 带 gitConfigPath（真实临时文件）→ 201/GET/磁盘回显；POST 双设/不存在路径 → 400', async () => {
    const cfgFile = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-gitcfg-'))), 'gitconfig')
    writeFileSync(cfgFile, '[user]\n\tname = gsm-test\n')

    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'zeta', url: o3.dir, gitConfigPath: cfgFile }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 'zeta', gitConfigPath: cfgFile })

    // GET 行映射：显式值回显；未设仓省键（undefined → JSON 省键，既有模式）
    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json().find((r: { id: string }) => r.id === 'zeta')).toMatchObject({ gitConfigPath: cfgFile })
    expect('gitConfigPath' in list.json().find((r: { id: string }) => r.id === 'r2')).toBe(false)

    // 磁盘 config.json 回写含显式值
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string; gitConfigPath?: string }[] }
    expect(cfg.repos.find(r => r.id === 'zeta')).toMatchObject({ gitConfigPath: cfgFile })

    // POST 双设 → schema refine 自动挡（400 invalid 透传，消息含"互斥"）
    const dual = await handle.app.inject({
      method: 'POST', url: '/api/repos',
      payload: { id: 'dual', url: o3.dir, bypassGitConfig: true, gitConfigPath: cfgFile }
    })
    expect(dual.statusCode).toBe(400)
    expect(dual.json()).toMatchObject({ code: 'invalid' })
    expect((dual.json() as { message: string }).message).toContain('互斥')

    // 创建时点校验：不存在路径 → 400 git_config_not_found，内存/调度器/磁盘不落
    const before = handle.schedulers.length
    const bad = await handle.app.inject({
      method: 'POST', url: '/api/repos',
      payload: { id: 'badcfg', url: o3.dir, gitConfigPath: '/nonexistent/gsm/gitconfig' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toEqual({
      code: 'git_config_not_found',
      message: '指定的 git 配置文件不存在: /nonexistent/gsm/gitconfig'
    })
    expect(handle.schedulers.length).toBe(before)
    expect(onDiskRepoIds()).not.toContain('badcfg')

    await awaitSettled('zeta')
    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/zeta' })).statusCode).toBe(200)
  })

  it('POST gitConfigPath 空串 → 400 invalid（repoSchema min(1) 空串收口，不落 existsSync(\'\') 的空路径文案）', async () => {
    const res = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'emptycfg', url: o3.dir, gitConfigPath: '' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid' })
    expect((res.json() as { message: string }).message).toContain('gitConfigPath')
    expect(onDiskRepoIds()).not.toContain('emptycfg')
    expect(handle.schedulers.some(s => s.repoId === 'emptycfg')).toBe(false)
  })

  it('PATCH 更新 gitConfigPath → 200 回显/磁盘（原位变更锁）；PATCH 不存在路径 → 400 且原值保留', async () => {
    const cfgFile = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-gitcfg-patch-'))), 'gitconfig')
    writeFileSync(cfgFile, '[user]\n\tname = gsm-test\n')
    const post = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'eta', url: o3.dir }
    })
    expect(post.statusCode).toBe(201)
    const repoRef = handle.config.repos.find(r => r.id === 'eta')

    const patch = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/eta', payload: { gitConfigPath: cfgFile }
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json()).toMatchObject({ id: 'eta', gitConfigPath: cfgFile })
    expect(handle.config.repos.find(r => r.id === 'eta')).toBe(repoRef)   // 原位变更锁
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string; gitConfigPath?: string }[] }
    expect(cfg.repos.find(r => r.id === 'eta')).toMatchObject({ gitConfigPath: cfgFile })

    // 更新路径回显：已设档案换另一真实档案 → 200 新路径回显（响应/内存/磁盘），原位锁保持
    const cfgFile2 = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-gitcfg-patch2-'))), 'gitconfig2')
    writeFileSync(cfgFile2, '[user]\n\tname = gsm-test-2\n')
    const patch2 = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/eta', payload: { gitConfigPath: cfgFile2 }
    })
    expect(patch2.statusCode).toBe(200)
    expect(patch2.json()).toMatchObject({ id: 'eta', gitConfigPath: cfgFile2 })
    expect(handle.config.repos.find(r => r.id === 'eta')).toBe(repoRef)
    expect(handle.config.repos.find(r => r.id === 'eta')!.gitConfigPath).toBe(cfgFile2)
    const cfg2 = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string; gitConfigPath?: string }[] }
    expect(cfg2.repos.find(r => r.id === 'eta')).toMatchObject({ gitConfigPath: cfgFile2 })

    // PATCH 不存在路径 → 400 git_config_not_found（创建/PATCH 时点校验），原值保留
    const bad = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/eta', payload: { gitConfigPath: '/nonexistent/gsm/patch' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ code: 'git_config_not_found' })
    expect(handle.config.repos.find(r => r.id === 'eta')!.gitConfigPath).toBe(cfgFile2)

    await awaitSettled('eta')
    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/eta' })).statusCode).toBe(200)
  })

  it('PATCH 互斥：body 双设 / 存量 bypass+PATCH path / 存量 path+PATCH bypass → 400 mutually_exclusive', async () => {
    const cfgFile = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-gitcfg-mx-'))), 'gitconfig')
    writeFileSync(cfgFile, '[user]\n\tname = gsm-test\n')
    const post = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'theta', url: o3.dir }
    })
    expect(post.statusCode).toBe(201)
    const repo = () => handle.config.repos.find(r => r.id === 'theta')!

    // 场景 A：body 同含 bypassGitConfig=true 与 gitConfigPath → 400 mutually_exclusive，两值均不落
    const both = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { bypassGitConfig: true, gitConfigPath: cfgFile }
    })
    expect(both.statusCode).toBe(400)
    expect(both.json()).toMatchObject({ code: 'mutually_exclusive' })
    expect(repo().bypassGitConfig).toBe(false)
    expect('gitConfigPath' in repo()).toBe(false)

    // 场景 B：存量 bypass=true，PATCH 仅 path → 生效态冲突同拒（放行落盘会让重启 loadConfig 崩溃）
    expect((await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { bypassGitConfig: true }
    })).statusCode).toBe(200)
    const diagB = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { gitConfigPath: cfgFile }
    })
    expect(diagB.statusCode).toBe(400)
    expect(diagB.json()).toMatchObject({ code: 'mutually_exclusive' })
    expect('gitConfigPath' in repo()).toBe(false)

    // 场景 C：存量 gitConfigPath，PATCH bypass=true → 同拒
    expect((await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { bypassGitConfig: false }
    })).statusCode).toBe(200)
    expect((await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { gitConfigPath: cfgFile }
    })).statusCode).toBe(200)
    const diagC = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/theta', payload: { bypassGitConfig: true }
    })
    expect(diagC.statusCode).toBe(400)
    expect(diagC.json()).toMatchObject({ code: 'mutually_exclusive' })
    expect(repo().bypassGitConfig).toBe(false)

    await awaitSettled('theta')
    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/theta' })).statusCode).toBe(200)
  })

  it('PATCH gitConfigPath:null → 显式 unset（响应/内存/磁盘省键）；键缺省不复活旧值', async () => {
    const cfgFile = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-gitcfg-null-'))), 'gitconfig')
    writeFileSync(cfgFile, '[user]\n\tname = gsm-test\n')
    const post = await handle.app.inject({
      method: 'POST', url: '/api/repos', payload: { id: 'iota', url: o3.dir, gitConfigPath: cfgFile }
    })
    expect(post.statusCode).toBe(201)
    await awaitSettled('iota')

    // JSON Merge Patch 风格（httpProxy:null 先例）：null = 显式移除字段
    const unset = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/iota', payload: { gitConfigPath: null }
    })
    expect(unset.statusCode).toBe(200)
    expect('gitConfigPath' in (unset.json() as Record<string, unknown>)).toBe(false)
    expect('gitConfigPath' in handle.config.repos.find(r => r.id === 'iota')!).toBe(false)
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { repos: { id: string; gitConfigPath?: string }[] }
    expect('gitConfigPath' in cfg.repos.find(r => r.id === 'iota')!).toBe(false)

    // 键缺省 → 不改动，绝不复活旧值
    expect((await handle.app.inject({
      method: 'PATCH', url: '/api/repos/iota', payload: { pollIntervalSeconds: 9 }
    })).statusCode).toBe(200)
    expect('gitConfigPath' in handle.config.repos.find(r => r.id === 'iota')!).toBe(false)

    expect((await handle.app.inject({ method: 'DELETE', url: '/api/repos/iota' })).statusCode).toBe(200)
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

  // 只关停：临时目录由文件级 afterAll cleanupTracked 统一清理（不再依赖外层 describe 的执行顺序）
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
    bypassGitConfig: boolean; httpProxy: string
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

  // 只关停：临时目录由文件级 afterAll cleanupTracked 统一清理；构建期 schedulers 不 start，无在飞写入
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
    // 返回形状与 GET /api/repos 行一致；p1 从未显式设过 httpProxy → undefined → JSON 省键
    expect(res.json()).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 7,
      bypassGitConfig: false
    })

    // 原位变更锁：config.repos 中仍是同一对象引用——Scheduler.deps.repo 持同引用，
    // 下一轮询周期才按新 pollIntervalSeconds 调度；整体替换对象会让此处拿到旧对象
    expect(handle.config.repos[0]).toBe(repoRef)
    expect(repoRef!.pollIntervalSeconds).toBe(7)
    expect(repoRef!.defaultBranch).toBe('main')
    expect(repoRef!.branchExclude).toEqual(['tmp/**'])
    expect(repoRef!.url).toBe(o.dir)
    expect('httpProxy' in repoRef!).toBe(false)   // PATCH 未提供的键不落对象（未设语义保留）

    // config 文件回写：新三字段 + bypassGitConfig default + url/id 未变；httpProxy 省键
    expect(onDiskRepo()).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 7,
      bypassGitConfig: false
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

    // GET /api/repos（读 config）与磁盘文件都反映最新值；httpProxy 未显式设置 → 省键
    const list = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(list.json()[0]).toEqual({
      id: 'p1', url: o.dir, defaultBranch: 'main', branchExclude: ['tmp/**'], pollIntervalSeconds: 11,
      bypassGitConfig: false
    })
    expect(onDiskRepo().pollIntervalSeconds).toBe(11)
  })

  it('PATCH pollIntervalSeconds=604801 超上界 → 400 invalid 且消息含 604800（与 repoSchema .max 同阈值）', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { pollIntervalSeconds: 604801 }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'invalid' })
    expect((res.json() as { message: string }).message).toContain('604800')
    // 非法值不落内存（沿用既有断言模式）
    expect(handle.config.repos[0].pollIntervalSeconds).toBe(11)
  })

  it('PATCH pollIntervalSeconds=5 → 200（最小合法值边界锁定），其余键不动', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { pollIntervalSeconds: 5 }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'p1', pollIntervalSeconds: 5, defaultBranch: 'main', branchExclude: ['tmp/**'] })
    expect(handle.config.repos[0].pollIntervalSeconds).toBe(5)
    expect(onDiskRepo().pollIntervalSeconds).toBe(5)
  })

  it('PATCH bypassGitConfig/httpProxy → 200 落内存与磁盘（白名单五键之一），config 回写含新值', async () => {
    const res = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { bypassGitConfig: true, httpProxy: 'http://127.0.0.1:9' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'p1', bypassGitConfig: true, httpProxy: 'http://127.0.0.1:9' })
    expect(handle.config.repos[0]).toMatchObject({ bypassGitConfig: true, httpProxy: 'http://127.0.0.1:9' })
    expect(onDiskRepo()).toMatchObject({ bypassGitConfig: true, httpProxy: 'http://127.0.0.1:9' })
    // 还原，不污染后续用例
    const reset = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { bypassGitConfig: false, httpProxy: '' }
    })
    expect(reset.statusCode).toBe(200)
  })

  it('PATCH bypassGitConfig/httpProxy 非法类型 → 400 invalid，非法值不落内存', async () => {
    for (const bad of [{ bypassGitConfig: 'yes' }, { httpProxy: 123 }]) {
      const res = await handle.app.inject({ method: 'PATCH', url: '/api/repos/p1', payload: bad })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid' })
    }
    expect(handle.config.repos[0].bypassGitConfig).toBe(false)
    expect(handle.config.repos[0].httpProxy).toBe('')
  })

  it('PATCH httpProxy:null → 显式 unset（响应/内存/磁盘省键，回到跟随系统）；键缺省不复活旧值', async () => {
    // 前置：先设显式代理，模拟"已设代理的仓"（修复前三态编辑死角：无法经 PATCH 还原跟随系统）
    const set = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { httpProxy: 'http://127.0.0.1:9' }
    })
    expect(set.statusCode).toBe(200)
    expect(handle.config.repos[0].httpProxy).toBe('http://127.0.0.1:9')

    // JSON Merge Patch 风格：null = 显式移除字段（undefined=跟随系统 git 配置）
    const unset = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { httpProxy: null }
    })
    expect(unset.statusCode).toBe(200)
    expect('httpProxy' in (unset.json() as Record<string, unknown>)).toBe(false)   // 响应行省键（与 GET 行同形）
    expect('httpProxy' in handle.config.repos[0]).toBe(false)                      // 内存字段已删除
    expect('httpProxy' in onDiskRepo()).toBe(false)                                // config.json 省键（undefined 不落 JSON）

    // 真 unset 锁：后续 PATCH 键缺省（httpProxy 不出现）→ 不改动，绝不复活旧值
    const again = await handle.app.inject({
      method: 'PATCH', url: '/api/repos/p1', payload: { pollIntervalSeconds: 6 }
    })
    expect(again.statusCode).toBe(200)
    expect('httpProxy' in handle.config.repos[0]).toBe(false)
    expect('httpProxy' in onDiskRepo()).toBe(false)
  })

  it('PATCH 回滚锁：httpProxy 变更遇 config 写失败 → 500 且内存精确还原（未设/设值两态，null 哨兵回滚）', async () => {
    // 让 writeConfig 必败：config.json 原位替换为目录（renameSync 落目录 → EISDIR 抛错）。
    // 本用例是该 describe 的收尾，configPath 拆坏不影响后续用例；用例内自清理
    rmSync(configPath)
    mkdirSync(configPath)
    try {
      expect((await handle.app.inject({
        method: 'PATCH', url: '/api/repos/p1', payload: { httpProxy: null }
      })).statusCode).toBe(500)

      // 场景 A：内存原值未设 → PATCH 设值 → 写失败回滚必须还原"未设"（哨兵 null → delete；
      // 回滚存 undefined 会让新值残留在内存，与磁盘不一致）
      const set = await handle.app.inject({
        method: 'PATCH', url: '/api/repos/p1', payload: { httpProxy: 'http://rollback:1' }
      })
      expect(set.statusCode).toBe(500)
      expect((set.json() as { code: string }).code).toBe('config_write_failed')
      expect('httpProxy' in handle.config.repos[0]).toBe(false)
      expect(handle.config.repos[0].pollIntervalSeconds).toBe(6)   // 同载荷其余键一并还原

      // 场景 B：内存原值在场（直接构造，绕过必败的写路径）→ PATCH null unset → 写失败
      // 回滚必须还原原值（snapshot 捕获 string 原样赋回）
      handle.config.repos[0].httpProxy = 'http://rollback:1'
      const unset = await handle.app.inject({
        method: 'PATCH', url: '/api/repos/p1', payload: { httpProxy: null }
      })
      expect(unset.statusCode).toBe(500)
      expect(handle.config.repos[0].httpProxy).toBe('http://rollback:1')
    } finally {
      rmSync(configPath, { recursive: true })   // 还原为不存在，外层 cleanupTracked 兜底
    }
  })
})

describe('POST /api/repos/:id/sync（v1.3.2 手动同步）', () => {
  let o: ReturnType<typeof createOriginRepo>
  let handle: AppHandle

  // buildApp 装配的 schedulers 只构造不 start（app.ts 先例）：无自动轮询竞争，
  // runOnce 节奏完全由用例经 sync 端点驱动——端点本身就是手动触发通道
  beforeAll(async () => {
    o = createOriginRepo('gsm-sync-')
    o.commitFile('s.txt', 's')   // 同秒同内容 SHA 碰撞规避（multirepo 先例）
    const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-syncapi-')))
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ repos: [{ id: 's1', url: o.dir }] }))
    handle = await buildApp({
      configPath: join(dir, 'config.json'),
      dataDir: trackTmp(mkdtempSync(join(tmpdir(), 'gsm-syncapi-data-')))
    })
  })

  // 只关停：临时目录由文件级 afterAll cleanupTracked 统一清理；schedulers 从未 start，close 时无在飞 runOnce
  afterAll(async () => { await handle.close() })

  it('未知仓 → 404 repo_not_found', async () => {
    const res = await handle.app.inject({ method: 'POST', url: '/api/repos/ghost/sync' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'repo_not_found' })
  })

  it('手动触发：首轮 clone+回填 → ok:true 检出回填提交；上游新提交后再触发 → newCommits=1；空轮 → 0', async () => {
    const first = await handle.app.inject({ method: 'POST', url: '/api/repos/s1/sync' })
    expect(first.statusCode).toBe(200)
    // 首轮全量回填不产生新提交事件，但回填检出行数经端点可见（README + s.txt）
    expect(first.json()).toEqual({ ok: true, newCommits: 2 })

    o.commitFile('manual.txt', 'm')   // 上游新提交
    const second = await handle.app.inject({ method: 'POST', url: '/api/repos/s1/sync' })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ ok: true, newCommits: 1 })

    // 无上游变化再触发：幂等空轮，载荷表达"无新提交"（始终 200）
    const third = await handle.app.inject({ method: 'POST', url: '/api/repos/s1/sync' })
    expect(third.statusCode).toBe(200)
    expect(third.json()).toEqual({ ok: true, newCommits: 0 })
  })

  it('自动轮询在飞（running 标志在位）→ ok:true + skipped:true + 文案，不炸不重复 fetch', async () => {
    const sched = handle.schedulers.find(s => s.repoId === 's1')
    expect(sched).toBeDefined()
    // 与 scheduler.test.ts 相同的标志操纵法：runOnce 互斥守卫读 running
    sched!.running = true
    try {
      const res = await handle.app.inject({ method: 'POST', url: '/api/repos/s1/sync' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true, skipped: true, message: '已有同步在进行中' })
    } finally {
      sched!.running = false   // 恢复，不污染后续用例
    }
  })

  it('远端不可达 → 仍 200，载荷 ok:false + error 透传（结果经载荷而非状态码表达）', async () => {
    rmSync(o.dir, { recursive: true, force: true })   // 远端消失（tracked 目录，cleanupTracked 幂等重删）
    const res = await handle.app.inject({ method: 'POST', url: '/api/repos/s1/sync' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; error?: string }
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.error!.length).toBeGreaterThan(0)
  })
})

// v1.4 测试卫生：文件级收尾——各 describe 的 handle.close()（describe 级 afterAll）先行，
// 此处统一 rmSync 全部 tracked 临时目录。原 cleanupTracked 挂在首个 describe 的 afterAll，
// 清理契约依赖 describe 执行顺序（其余 describe 只能"恰好"在其后运行）；收敛到文件级后
// 顺序耦合消除（vitest 文件级 afterAll 恒晚于全部 describe 级 afterAll）
afterAll(() => cleanupTracked())
