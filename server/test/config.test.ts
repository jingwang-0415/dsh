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
})

describe('isBranchExcluded', () => {
  it('支持 * 与 ** glob', () => {
    expect(isBranchExcluded('tmp/foo', ['tmp/*'])).toBe(true)
    expect(isBranchExcluded('release/x/tmp/y', ['**/tmp/*'])).toBe(true)
    expect(isBranchExcluded('master', ['tmp/*'])).toBe(false)
    expect(isBranchExcluded('release/1.0', [])).toBe(false)
  })
})
