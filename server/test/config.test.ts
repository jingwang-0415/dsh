import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTracked, trackTmp } from './fixture.js'
import { isBranchExcluded, loadConfig } from '../src/config.js'

afterEach(cleanupTracked)

function writeConfig(json: unknown): string {
  const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-config-')))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(json))
  return file
}

const valid = { repos: [{ id: 'demo', url: 'ssh://git@example.com/demo.git' }] }

describe('loadConfig', () => {
  it('解析合法配置并填充默认值', () => {
    const cfg = loadConfig(writeConfig(valid))
    expect(cfg.repos[0]).toMatchObject({ id: 'demo', defaultBranch: 'master', pollIntervalSeconds: 30, branchExclude: [] })
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 43900 })
  })
  it('缺少 url 时报错并指明字段', () => {
    expect(() => loadConfig(writeConfig({ repos: [{ id: 'demo' }] }))).toThrow(/url/)
  })
  it('配置文件不存在时报错', () => {
    expect(() => loadConfig('/nonexistent/gsm/config.json')).toThrow(/无法读取配置文件/)
  })
  it('repos 为空时报错', () => {
    expect(() => loadConfig(writeConfig({ repos: [] }))).toThrow()
  })
  it('双仓同 id 报 repo id 必须唯一', () => {
    const dup = {
      repos: [
        { id: 'demo', url: 'ssh://git@example.com/a.git' },
        { id: 'demo', url: 'ssh://git@example.com/b.git' }
      ]
    }
    expect(() => loadConfig(writeConfig(dup))).toThrow(/repo id 必须唯一/)
  })
  it('pollIntervalSeconds=604801 超上界 → 报错含 604800 文案（防 setTimeout >2^31-1 钳制紧循环）', () => {
    // Node 对 delay > 2^31-1ms 的 setTimeout 钳为 1ms：无上界时 ≥2147484 秒（约 24.85 天）
    // 会让调度器变成"每轮 fetch 完立刻 1ms 重排"的连续 fetch 循环，故钳上界 7 天
    expect(() => loadConfig(writeConfig({
      repos: [{ id: 'demo', url: 'ssh://git@example.com/demo.git', pollIntervalSeconds: 604801 }]
    }))).toThrow(/604800/)
  })
  it('repo id 越白名单（../ 逃逸、空格）报错并含白名单文案', () => {
    // id 同时是 mirror 目录名：../demo 会逃出 repos/ 根目录
    for (const id of ['../demo', 'a b']) {
      expect(() => loadConfig(writeConfig({ repos: [{ id, url: 'ssh://git@example.com/demo.git' }] })))
        .toThrow(/id 仅允许字母数字与 \. _ -/)
    }
  })
  it('repo id 为 . 或 .. 报错（refine 封死 mirror 目录逃逸删除链）', () => {
    // '..' 过白名单正则但 mirrorDirFor 会把仓库目录解析到 repos/ 之外
    for (const id of ['..', '.']) {
      expect(() => loadConfig(writeConfig({ repos: [{ id, url: 'ssh://git@example.com/demo.git' }] })))
        .toThrow(/id 不能为/)
    }
  })
  it('传输兜底字段默认值：bypassGitConfig=false / httpProxy=\'\'（缺省不兜底，行为不变）', () => {
    const cfg = loadConfig(writeConfig(valid))
    expect(cfg.repos[0].bypassGitConfig).toBe(false)
    expect(cfg.repos[0].httpProxy).toBe('')
  })
  it('传输兜底字段显式值解析保留（true / 代理串）', () => {
    const cfg = loadConfig(writeConfig({
      repos: [{ id: 'demo', url: 'ssh://git@example.com/demo.git', bypassGitConfig: true, httpProxy: 'http://p:1' }]
    }))
    expect(cfg.repos[0].bypassGitConfig).toBe(true)
    expect(cfg.repos[0].httpProxy).toBe('http://p:1')
  })
})

describe('isBranchExcluded', () => {
  it('支持 * 与 ** glob', () => {
    expect(isBranchExcluded('tmp/foo', ['tmp/*'])).toBe(true)
    expect(isBranchExcluded('release/x/tmp/y', ['**/tmp/*'])).toBe(true)
    expect(isBranchExcluded('master', ['tmp/*'])).toBe(false)
    expect(isBranchExcluded('release/1.0', [])).toBe(false)
  })
})
