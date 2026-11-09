import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'

afterEach(cleanupTracked)
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'

/**
 * 回归背景（审查 I2）：hijack 的 SSE 流对 Fastify v5 非 idle 连接，
 * app.close() 只清 idle 连接 → 有 SSE 客户端时优雅退出永久悬挂。
 * 修复后 close() 须先 sse.closeAll() 再 app.close()，在限时内完成。
 */
describe('优雅退出（存在 SSE 连接）', () => {
  it('close() 在有 SSE 客户端时 3s 内完成，不永久悬挂', async () => {
    const origin = createOriginRepo()
    const handle: AppHandle = await buildApp({
      configOverride: {
        repos: [{ id: 'shutdown', url: origin.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
        server: { host: '127.0.0.1', port: 0 }
      },
      dataDir: trackTmp(mkdtempSync(join(tmpdir(), 'gsm-shutdown-')))
    })
    await handle.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = handle.app.server.address() as { port: number } | null
    expect(addr).not.toBeNull()

    // 建立 SSE 连接并保持（收到首帧 retry 行即代表服务端已完成 hijack 与登记）
    const firstFrame = new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: addr!.port, path: '/api/events' }, res => {
        res.on('data', () => { resolve() })   // 持续消费流，保持连接
        res.on('error', () => {})             // 服务器销毁流后的客户端侧错误属预期
      })
      req.on('error', err => reject(err))
    })
    await firstFrame
    expect(handle.sse.clientCount()).toBe(1)

    try {
      await Promise.race([
        handle.close(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('close() 超过 3s 未完成：SSE 连接导致优雅退出悬挂')), 3_000).unref()
        )
      ])
    } catch (e) {
      // 失败兜底清理（限时），避免悬挂句柄污染测试进程
      handle.schedulers[0].stop()
      handle.sse.closeAll()
      const bounded = new Promise<void>(resolve => setTimeout(resolve, 1_000).unref())
      await Promise.race([handle.app.close().then(() => {}, () => {}), bounded])
      throw e
    }
    expect(handle.sse.clientCount()).toBe(0)
  })
})
