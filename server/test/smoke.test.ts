import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('app 冒烟', () => {
  it('GET /api/ping 返回 pong', async () => {
    const { app, close } = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: true })
    await close()
  })
})
