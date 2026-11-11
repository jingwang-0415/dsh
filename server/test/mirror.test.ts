import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp, withProxyEnvCleared } from './fixture.js'

afterEach(cleanupTracked)
import { ensureMirror, fetchMirror, snapshotRefs, transportArgs } from '../src/mirror.js'
import { loadConfig } from '../src/config.js'

// spawn 捕获桩：vi.spyOn 在本 vitest v3/ESM 环境对 node 内建模块不可行
// （TypeError: Module namespace is not configurable / Cannot redefine property，已实证），
// 改用 importOriginal 透传包装——捕获真实 spawn 的 (bin, args, opts) 且执行行为逐字节不变。
const spawnCalls = vi.hoisted(() => [] as Array<[string, string[], Record<string, unknown> | undefined]>)
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const [bin, cmdArgs, opts] = args
      spawnCalls.push([bin, cmdArgs as string[], opts as Record<string, unknown> | undefined])
      return actual.spawn(...args)
    }) as typeof actual.spawn
  }
})

describe('mirror', () => {
  it('ensureMirror 首次克隆，二次复用', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    expect(await ensureMirror(origin.dir, mirrorDir)).toBe('cloned')
    expect(await ensureMirror(origin.dir, mirrorDir)).toBe('existing')
  })

  it('fetch 后快照可见新分支', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    let snap = await snapshotRefs(mirrorDir)
    expect(Object.keys(snap)).toEqual(['master'])

    origin.git(['checkout', '-b', 'release/1.0'])
    origin.commitFile('rel.txt', 'r1')
    origin.git(['checkout', 'master'])
    await fetchMirror(mirrorDir)
    snap = await snapshotRefs(mirrorDir)
    expect(Object.keys(snap).sort()).toEqual(['master', 'release/1.0'])
    expect(snap['master']).toMatch(/^[0-9a-f]{40}$/)
  })
})

// —— v1.3.2 Task 1：按仓传输兜底（bypassGitConfig 直连 / httpProxy 显式覆盖）——
// 探针实证（git 2.50.1 / Apple Git-155）：GIT_CONFIG_GLOBAL 劫持的 http.proxy 同样打断
// clone 与 fetch；`-c http.proxy=`（空串）可覆盖全局配置恢复直连；no_proxy 等环境变量
// 会遮蔽代理行为，故劫持用例显式清空代理环境变量保证确定性（离线、无 DNS 依赖）。

describe('transportArgs（纯函数，fix round 1 三分支语义）', () => {
  it('httpProxy 非空 → 带值 -c 对；\'\' → 空 -c 对（强制无代理）', () => {
    expect(transportArgs({ httpProxy: 'http://p:1' })).toEqual([
      '-c', 'http.proxy=http://p:1', '-c', 'https.proxy=http://p:1'
    ])
    expect(transportArgs({ httpProxy: '' })).toEqual(['-c', 'http.proxy=', '-c', 'https.proxy='])
  })

  it('httpProxy 未设（undefined=跟随系统 git 配置）或仅 bypass → 不产生 args（bypass 走 env）', () => {
    expect(transportArgs({})).toEqual([])
    expect(transportArgs({ bypassGitConfig: true })).toEqual([])
    expect(transportArgs({ bypassGitConfig: true, httpProxy: undefined })).toEqual([])
  })
})

describe('mirror 传输兜底（真实 git 行为）', () => {
  /** withProxyEnvCleared 已抽到共享 util（./fixture.ts），劫持用例沿用（见 fixture.ts 顶部注释） */

  /**
   * 本地静态服务器伺服裸仓（dumb HTTP 协议）：离线复现"内源代理劫持 git 全局配置"场景。
   * update-server-info 生成 info/refs 与对象索引后，纯静态伺服即可完成 clone/fetch（探针已证）。
   */
  async function makeHttpOrigin(prefix: string): Promise<{ url: string; close(): Promise<void> }> {
    const origin = createOriginRepo(prefix)
    const bare = join(trackTmp(mkdtempSync(join(tmpdir(), prefix + '-http-'))), 'bare.git')
    const g = (args: string[], cwd: string): void => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} 失败: ${r.stderr}`)
    }
    g(['clone', '--bare', origin.dir, bare], origin.dir)
    g(['update-server-info'], bare)
    const server = createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
      readFile(join(bare, rel))
        .then(data => res.end(data))
        .catch(() => { res.statusCode = 404; res.end('not found') })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { url, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
  }

  it('fetchMirror 带 bypassGitConfig 在本地 fixture 远端真实跑通（env 变换不破坏功能）', async () => {
    const origin = createOriginRepo('gsm-tp-bp-')
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.commitFile('rel.txt', 'r1')
    origin.git(['checkout', 'master'])
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-bp-m-'))), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    await fetchMirror(mirrorDir, { bypassGitConfig: true })
    const snap = await snapshotRefs(mirrorDir)
    expect(Object.keys(snap).sort()).toEqual(['master', 'release/1.0'])
  })

  it('全局配置代理劫持：无兜底 clone 失败；bypassGitConfig 直连成功；httpProxy 空串强制无代理成功', async () => {
    // 劫持：全局配置指向端口 9（discard，必然连接拒绝）
    const hijack = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hj-'))), 'gitconfig')
    writeFileSync(hijack, '[http]\n\tproxy = http://127.0.0.1:9\n')
    const { url, close } = await makeHttpOrigin('gsm-tp-hj-')
    try {
      await withProxyEnvCleared(async () => {
        const savedGlobal = process.env.GIT_CONFIG_GLOBAL
        process.env.GIT_CONFIG_GLOBAL = hijack
        try {
          // 对照组：不带兜底 → 克隆被劫持代理打断
          const ctl = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hj-ctl-'))), 'ctl.git')
          await expect(ensureMirror(url, ctl))
            .rejects.toThrow(/unable to access|Failed to connect|refused|拒绝|resolve|解析/i)
          // bypassGitConfig：GIT_CONFIG_GLOBAL/SYSTEM=/dev/null → 直连成功
          const bypassed = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hj-bp-'))), 'bp.git')
          expect(await ensureMirror(url, bypassed, { bypassGitConfig: true })).toBe('cloned')
          // httpProxy 空串：-c http.proxy= 覆盖全局配置 → 强制无代理成功（探针实证语义）
          const forced = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hj-fp-'))), 'fp.git')
          expect(await ensureMirror(url, forced, { httpProxy: '' })).toBe('cloned')
        } finally {
          if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
          else process.env.GIT_CONFIG_GLOBAL = savedGlobal
        }
      })
    } finally { await close() }
  })

  it('劫持下 fetchMirror：无兜底被代理打断；bypassGitConfig 直连恢复（fetch 侧直测）', async () => {
    // clone 全链已有劫持用例（上）；fetch 走同款 env 变换机制，此处补直测缺口：
    // 对照组证明 fetch 真实接触远端（否则无兜底不会失败），bypass 后同一镜像 fetch 恢复
    const hijack = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hjf-'))), 'gitconfig')
    writeFileSync(hijack, '[http]\n\tproxy = http://127.0.0.1:9\n')
    const { url, close } = await makeHttpOrigin('gsm-tp-hjf-')
    try {
      const dir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-hjf-m-'))), 'm.git')
      await withProxyEnvCleared(async () => {
        await ensureMirror(url, dir)   // 无劫持：正常克隆建立基线
        const savedGlobal = process.env.GIT_CONFIG_GLOBAL
        process.env.GIT_CONFIG_GLOBAL = hijack
        try {
          // 对照组：不带兜底 → fetch 被劫持代理打断
          await expect(fetchMirror(dir))
            .rejects.toThrow(/unable to access|Failed to connect|refused|拒绝|resolve|解析/i)
          // bypassGitConfig：GIT_CONFIG_GLOBAL/SYSTEM=/dev/null → fetch 直连恢复
          await fetchMirror(dir, { bypassGitConfig: true })
        } finally {
          if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
          else process.env.GIT_CONFIG_GLOBAL = savedGlobal
        }
      })
    } finally { await close() }
  })

  it('httpProxy 显式代理在 fetch 上真实生效（-c 前缀到达 spawn 并改变 git 行为）', async () => {
    const { url, close } = await makeHttpOrigin('gsm-tp-fx-')
    try {
      await withProxyEnvCleared(async () => {
        const dir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-fx-m-'))), 'm.git')
        await ensureMirror(url, dir)   // 无劫持：正常克隆建立基线
        await expect(fetchMirror(dir, { httpProxy: 'http://127.0.0.1:9' }))
          .rejects.toThrow(/unable to access|Failed to connect|refused|拒绝|resolve|解析/i)
      })
    } finally { await close() }
  })

  it('存量配置不变性：config 无 httpProxy 键 → loadConfig 后 spawn 无 -c 前缀且无 env 覆盖', async () => {
    // fix round 1：手写 v1.3.1 形态 config.json（无传输字段）——未设语义必须逐字节保留
    const cfgDir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-legacy-')))
    const cfgFile = join(cfgDir, 'config.json')
    writeFileSync(cfgFile, JSON.stringify({ repos: [{ id: 'legacy', url: 'file:///tmp/unused' }] }))
    const repo = loadConfig(cfgFile).repos[0]
    expect(repo.httpProxy).toBeUndefined()
    expect('httpProxy' in repo).toBe(false)

    const origin = createOriginRepo('gsm-tp-lg-')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-lg-m-'))), 'm.git')
    // 与 scheduler runOnce 同构造：字段可能为 undefined，由 transportArgs 分支消化
    const transport = { bypassGitConfig: repo.bypassGitConfig, httpProxy: repo.httpProxy }
    spawnCalls.length = 0
    await ensureMirror(origin.dir, mirrorDir, transport)
    await fetchMirror(mirrorDir, transport)
    const gitCalls = spawnCalls.filter(([bin]) => bin === 'git')
    expect(gitCalls).toHaveLength(2)   // clone + fetch 真实执行
    for (const [, args, opts] of gitCalls) {
      expect(args).not.toContain('-c')                          // 未设 → 无任何代理参数注入
      expect(opts != null && 'env' in opts).toBe(false)         // 未开 bypass → 无 env 覆盖键
    }
  })

  it('显式空串：config 带 "httpProxy": "" → spawn args 含空 -c 对（强制无代理语义可达）', async () => {
    const cfgDir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-emptycfg-')))
    const cfgFile = join(cfgDir, 'config.json')
    writeFileSync(cfgFile, JSON.stringify({ repos: [{ id: 'force', url: 'file:///tmp/unused', httpProxy: '' }] }))
    const repo = loadConfig(cfgFile).repos[0]
    expect(repo.httpProxy).toBe('')

    const origin = createOriginRepo('gsm-tp-ec-')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-tp-ec-m-'))), 'm.git')
    spawnCalls.length = 0
    await ensureMirror(origin.dir, mirrorDir, { bypassGitConfig: repo.bypassGitConfig, httpProxy: repo.httpProxy })
    const gitCalls = spawnCalls.filter(([bin]) => bin === 'git')
    expect(gitCalls).toHaveLength(1)
    expect(gitCalls[0][1].slice(0, 4)).toEqual(['-c', 'http.proxy=', '-c', 'https.proxy='])
    expect(gitCalls[0][2] != null && 'env' in gitCalls[0][2]).toBe(false)   // bypass 未开 → 无 env 覆盖
  })
})
