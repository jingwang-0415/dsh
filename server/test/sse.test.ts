import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createSseHub } from '../src/sse.js'
import type { FastifyReply } from 'fastify'

function fakeReply(): { reply: FastifyReply; writes: string[] } {
  const writes: string[] = []
  const res = new EventEmitter() as EventEmitter & { writeHead: unknown; write: unknown }
  ;(res as Record<string, unknown>).writeHead = () => {}
  ;(res as Record<string, unknown>).write = (s: string) => { writes.push(s) }
  ;(res as Record<string, unknown>).destroy = () => {}   // closeAll 路径需要；特例用例自行覆写
  const reply = { hijack: () => {}, raw: res } as unknown as FastifyReply
  return { reply, writes }
}

describe('SseHub', () => {
  it('publish 广播到所有客户端', () => {
    const hub = createSseHub()
    const a = fakeReply()
    const b = fakeReply()
    hub.add(a.reply)
    hub.add(b.reply)
    expect(hub.clientCount()).toBe(2)
    hub.publish('commits.new', { branch: 'master', count: 1 })
    expect(a.writes.some(w => w.includes('event: commits.new') && w.includes('"count":1'))).toBe(true)
    expect(b.writes.some(w => w.includes('event: commits.new'))).toBe(true)
  })

  it('publish 对 destroyed=true 的客户端不抛错且 clientCount 归零', () => {
    const hub = createSseHub()
    const dead = fakeReply()
    ;(dead.reply.raw as unknown as { destroyed: boolean }).destroyed = true
    expect(() => hub.add(dead.reply)).not.toThrow()
    expect(() => hub.publish('status.changed', { state: 'idle' })).not.toThrow()
    expect(dead.writes.every(w => !w.includes('event: status.changed'))).toBe(true)
    expect(hub.clientCount()).toBe(0)
  })

  it('publish 同步 write 抛错时摘除该客户端且不影响其他客户端', () => {
    const hub = createSseHub()
    const broken = fakeReply()
    let firstWrite = false
    ;(broken.reply.raw as unknown as { write: unknown }).write = (s: string) => {
      if (firstWrite) throw new Error('write after end')   // 首帧（retry 行）成功，publish 阶段才抛
      firstWrite = true
      broken.writes.push(s)
    }
    const good = fakeReply()
    hub.add(broken.reply)
    hub.add(good.reply)
    expect(hub.clientCount()).toBe(2)
    expect(() => hub.publish('branches.updated', {})).not.toThrow()
    expect(hub.clientCount()).toBe(1)
    expect(good.writes.some(w => w.includes('event: branches.updated'))).toBe(true)
  })

  it('socket error 事件（ERR_STREAM_DESTROYED/EPIPE）触发客户端清理', () => {
    const hub = createSseHub()
    const a = fakeReply()
    hub.add(a.reply)
    expect(hub.clientCount()).toBe(1)
    ;(a.reply.raw as EventEmitter).emit('error', new Error('ERR_STREAM_DESTROYED'))
    expect(hub.clientCount()).toBe(0)
  })

  it('closeAll 销毁全部客户端并清空集合', () => {
    const hub = createSseHub()
    const a = fakeReply()
    const b = fakeReply()
    hub.add(a.reply)
    hub.add(b.reply)
    const destroyed: unknown[] = []
    for (const r of [a.reply.raw, b.reply.raw]) {
      ;(r as unknown as { destroy: () => void }).destroy = () => destroyed.push(r)
    }
    hub.closeAll()
    expect(destroyed).toHaveLength(2)
    expect(hub.clientCount()).toBe(0)
  })

  it('惰性心跳：有客户端时每 25s 广播 :ping，closeAll 后停止写入', () => {
    vi.useFakeTimers()
    try {
      const hub = createSseHub()
      const a = fakeReply()
      const b = fakeReply()
      hub.add(a.reply)
      hub.add(b.reply)
      vi.advanceTimersByTime(25_000)
      expect(a.writes.some(w => w.includes(':ping'))).toBe(true)
      expect(b.writes.some(w => w.includes(':ping'))).toBe(true)
      hub.closeAll()
      const writesBefore = a.writes.length
      vi.advanceTimersByTime(60_000)
      expect(a.writes.length).toBe(writesBefore)
      expect(hub.clientCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('心跳随最后一个客户端断开（close 事件）停止', () => {
    vi.useFakeTimers()
    try {
      const hub = createSseHub()
      const a = fakeReply()
      hub.add(a.reply)
      vi.advanceTimersByTime(25_000)
      expect(a.writes.some(w => w.includes(':ping'))).toBe(true)
      ;(a.reply.raw as EventEmitter).emit('close')   // 客户端断开，clients 清空
      const writesBefore = a.writes.length
      vi.advanceTimersByTime(60_000)
      expect(a.writes.length).toBe(writesBefore)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publish 摘除 destroyed 客户端后心跳停表（定时器归零，advance 无 :ping）', () => {
    // 停表闭环：clients 清空必须 clearInterval，否则空转定时器常驻（写计数无法区分——
    // 空集 sweep 本就不产生写入，故用 vi.getTimerCount() 直接断言定时器归零）
    vi.useFakeTimers()
    try {
      const hub = createSseHub()
      const a = fakeReply()
      const b = fakeReply()
      hub.add(a.reply)
      hub.add(b.reply)
      expect(vi.getTimerCount()).toBe(1)
      ;(a.reply.raw as unknown as { destroyed: boolean }).destroyed = true
      ;(b.reply.raw as unknown as { destroyed: boolean }).destroyed = true
      expect(() => hub.publish('status.changed', {})).not.toThrow()
      expect(hub.clientCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)   // 摘除后停表
      vi.advanceTimersByTime(25_000)
      expect(a.writes.every(w => !w.includes(':ping'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ping sweep 摘除 destroyed 客户端后心跳停表', () => {
    vi.useFakeTimers()
    try {
      const hub = createSseHub()
      const a = fakeReply()
      hub.add(a.reply)
      ;(a.reply.raw as unknown as { destroyed: boolean }).destroyed = true
      vi.advanceTimersByTime(25_000)   // sweep tick 摘除 destroyed 客户端
      expect(hub.clientCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)   // 摘除后停表
    } finally {
      vi.useRealTimers()
    }
  })
})
