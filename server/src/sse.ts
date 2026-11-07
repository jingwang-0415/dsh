import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'

export interface SseHub {
  add(reply: FastifyReply): void
  publish(event: string, data: unknown): void
  clientCount(): number
  closeAll(): void
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
      try {
        res.write('retry: 3000\n\n')
      } catch {
        return   // 首帧即写失败的连接不纳入广播集合，避免异常逸出到路由处理
      }
      clients.add(res)
      res.on('close', () => { clients.delete(res) })
      // 已销毁 socket 的 write 会异步 emit error（ERR_STREAM_DESTROYED/EPIPE），
      // OutgoingMessage 无 error listener 时会升级为 uncaughtException 直接杀死进程
      res.on('error', () => { clients.delete(res) })
    },
    publish(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      for (const res of clients) {
        // 遍历中对已销毁连接跳过并摘除；write 同步抛错（如流已关闭）同样摘除
        if (res.destroyed) { clients.delete(res); continue }
        try {
          res.write(payload)
        } catch {
          clients.delete(res)
        }
      }
    },
    clientCount() { return clients.size },
    // 优雅退出用：hijack 的 SSE 连接对 Fastify 非 idle，app.close() 会永久等待；
    // 先同步销毁全部 SSE 流再交还关闭流程
    closeAll() {
      for (const res of clients) res.destroy()
      clients.clear()
    }
  }
}
