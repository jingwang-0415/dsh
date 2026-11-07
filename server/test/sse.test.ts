import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSseHub } from '../src/sse.js'
import type { FastifyReply } from 'fastify'

function fakeReply(): { reply: FastifyReply; writes: string[] } {
  const writes: string[] = []
  const res = new EventEmitter() as EventEmitter & { writeHead: unknown; write: unknown }
  ;(res as Record<string, unknown>).writeHead = () => {}
  ;(res as Record<string, unknown>).write = (s: string) => { writes.push(s) }
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
})
