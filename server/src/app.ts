import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { loadConfig, type AppConfig } from './config.js'
import { openDb } from './db.js'
import { Scheduler } from './scheduler.js'
import { createSseHub, type SseHub } from './sse.js'
import { registerApi } from './api.js'
import { nullAdapter, type PlatformAdapter } from './platform/types.js'

export interface AppOptions {
  configPath?: string
  dataDir?: string
  configOverride?: AppConfig
  adapter?: PlatformAdapter
}

export interface AppHandle {
  app: FastifyInstance
  config: AppConfig
  scheduler: Scheduler
  sse: SseHub
  close(): Promise<void>
}

export async function buildApp(options: AppOptions = {}): Promise<AppHandle> {
  const config = options.configOverride
    ?? loadConfig(options.configPath ?? join(homedir(), '.git-sync-monitor', 'config.json'))
  const dataDir = options.dataDir ?? join(homedir(), '.git-sync-monitor')
  const db: Database.Database = openDb(join(dataDir, 'monitor.db'))
  const mirrorDirFor = (repoId: string): string => join(dataDir, 'repos', repoId)
  const sse: SseHub = createSseHub()
  const repo = config.repos[0]
  // repos 表是 fetch_events/branches/commits 外键的宿主（openDb 开启 foreign_keys），
  // 装配时幂等登记，否则调度器首跑即因 FK 约束失败；
  // 同 id 改 URL 时 upsert 更新 url/default_branch，created_at 保留原值
  db.prepare(
    `INSERT INTO repos (id, url, default_branch, created_at) VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET url=excluded.url, default_branch=excluded.default_branch`
  ).run(repo.id, repo.url, repo.defaultBranch, Date.now())

  const scheduler = new Scheduler({
    db, repo, mirrorDir: mirrorDirFor(repo.id),
    handlers: {
      onCommitsNew: (branch, commits) => sse.publish('commits.new', {
        branch, count: commits.length, subjects: commits.slice(0, 5).map(c => c.subject)
      }),
      onBranchesUpdated: () => sse.publish('branches.updated', {}),
      onStatus: s => sse.publish('status.changed', s)
    }
  })

  const app = Fastify({ logger: false })
  app.get('/api/ping', async () => ({ pong: true }))
  await registerApi(app, { config, db, mirrorDirFor, scheduler, sse, adapter: options.adapter ?? nullAdapter })

  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  if (existsSync(webDist)) {
    const fastifyStatic = (await import('@fastify/static')).default
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ code: 'not_found' })
      return reply.sendFile('index.html')
    })
  }

  const close = async (): Promise<void> => {
    scheduler.stop()
    // hijack 的 SSE 流对 Fastify 非 idle，app.close() 只清 idle 连接会永久悬挂；
    // 先同步销毁全部 SSE 客户端再走正常关闭
    sse.closeAll()
    await app.close()
    db.close()
  }
  return { app, config, scheduler, sse, close }
}
