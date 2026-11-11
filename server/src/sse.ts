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
  // 惰性心跳：仅在存在客户端时运行，防止反向代理/中间层把无写入的 SSE 连接当空闲掐断；
  // clients 清空（close/error 事件或 closeAll）即 clearInterval，避免空转定时器
  let timer: NodeJS.Timeout | null = null
  const stopHeartbeatIfIdle = (): void => {
    if (timer !== null && clients.size === 0) {
      clearInterval(timer)
      timer = null
    }
  }
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
      if (clients.size === 1 && timer === null) {
        timer = setInterval(() => {
          for (const res of clients) {
            if (res.destroyed) { clients.delete(res); continue }
            try {
              res.write(':ping\n\n')
            } catch {
              clients.delete(res)
            }
          }
          stopHeartbeatIfIdle()   // sweep 摘除后停表闭环（与 close/error 事件路径对称）
        }, 25_000)
        timer.unref()   // 不阻止进程优雅退出
      }
      res.on('close', () => { clients.delete(res); stopHeartbeatIfIdle() })
      // 已销毁 socket 的 write 会异步 emit error（ERR_STREAM_DESTROYED/EPIPE），
      // OutgoingMessage 无 error listener 时会升级为 uncaughtException 直接杀死进程
      res.on('error', () => { clients.delete(res); stopHeartbeatIfIdle() })
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
      stopHeartbeatIfIdle()   // 摘除（destroyed/抛错分支）后停表闭环（与 close/error 事件路径对称）
    },
    clientCount() { return clients.size },
    // 优雅退出用：hijack 的 SSE 连接对 Fastify 非 idle，app.close() 会永久等待；
    // 先同步销毁全部 SSE 流再交还关闭流程
    closeAll() {
      for (const res of clients) res.destroy()
      clients.clear()
      stopHeartbeatIfIdle()
    }
  }
}
