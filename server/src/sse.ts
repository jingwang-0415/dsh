import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'

export interface SseHub {
  add(reply: FastifyReply): void
  publish(event: string, data: unknown): void
  clientCount(): number
}

export function createSseHub(): SseHub {
  const clients = new Set<ServerResponse>()
  return {
    add(reply) {
      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      res.on('close', () => { clients.delete(res) })
    },
    publish(event, data) {
      for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    clientCount() { return clients.size }
  }
}
