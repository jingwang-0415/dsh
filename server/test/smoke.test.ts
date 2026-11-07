import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

const testConfig: AppConfig = {
  repos: [{ id: 't', url: '/tmp/does-not-matter', defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
  server: { host: '127.0.0.1', port: 43900 }
}

describe('app 冒烟', () => {
  it('GET /api/ping 返回 pong', async () => {
    const { app, close } = await buildApp({ configOverride: testConfig, dataDir: mkdtempSync(join(tmpdir(), 'gsm-smoke-')) })
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: true })
    await close()
  })
})
