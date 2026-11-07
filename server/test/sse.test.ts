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
})
