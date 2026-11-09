import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { loadConfig, type AppConfig, type RepoConfig } from './config.js'
import { openDb } from './db.js'
import { Scheduler, type SchedulerHandlers } from './scheduler.js'
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
  /** 实际生效（或将被回写）的 config.json 路径：configOverride 时也提供可写目标 */
  configPath: string
  schedulers: Scheduler[]
  sse: SseHub
  close(): Promise<void>
}

export async function buildApp(options: AppOptions = {}): Promise<AppHandle> {
  const configPath = options.configPath ?? join(homedir(), '.git-sync-monitor', 'config.json')
  const config = options.configOverride ?? loadConfig(configPath)
  const dataDir = options.dataDir ?? join(homedir(), '.git-sync-monitor')
  const db: Database.Database = openDb(join(dataDir, 'monitor.db'))
  const mirrorDirFor = (repoId: string): string => join(dataDir, 'repos', repoId)
  const sse: SseHub = createSseHub()
  const makeHandlers = (repo: RepoConfig): SchedulerHandlers => ({
    onCommitsNew: (branch, commits) => sse.publish('commits.new', {
      repoId: repo.id, branch, count: commits.length,
      subjects: commits.slice(0, 5).map(c => c.subject)
    }),
    onBranchesUpdated: () => sse.publish('branches.updated', { repoId: repo.id }),
    onStatus: st => sse.publish('status.changed', { repoId: repo.id, ...st })
  })

  // 启动期 schedulers 保持"只构造不 start"（与既有行为等价）：index.ts 统一 forEach start，
  // 测试可手动 runOnce 控制节奏；API 新挂仓走 addScheduler（构造 + start）实现免重启
  // repos 表是 fetch_events/branches/commits 外键的宿主（openDb 开启 foreign_keys），
  // 装配时逐仓幂等登记，否则调度器首跑即因 FK 约束失败；
  // 同 id 改 URL 时 upsert 更新 url/default_branch，created_at 保留原值；
  // 删除过的仓重挂时命中已有行（历史接续，POST/DELETE 均不清理 DB 数据）
  const schedulers: Scheduler[] = config.repos.map(repo => {
    db.prepare(
      `INSERT INTO repos (id, url, default_branch, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET url=excluded.url, default_branch=excluded.default_branch`
    ).run(repo.id, repo.url, repo.defaultBranch, Date.now())
    return new Scheduler({ db, repo, mirrorDir: mirrorDirFor(repo.id), handlers: makeHandlers(repo) })
  })

  /** API 挂新仓：构造 + 入列 + 立即 start（一次 start，调用方不得再 start） */
  const addScheduler = (repo: RepoConfig): Scheduler => {
    const s = new Scheduler({ db, repo, mirrorDir: mirrorDirFor(repo.id), handlers: makeHandlers(repo) })
    schedulers.push(s)
    s.start()
    return s
  }

  /** API 摘仓：按 repoId 定位 → stop（清 timer）→ 出列；找不到幂等返回 */
  const removeScheduler = (id: string): void => {
    const i = schedulers.findIndex(s => s.repoId === id)
    if (i === -1) return
    schedulers[i].stop()
    schedulers.splice(i, 1)
  }

  const app = Fastify({ logger: false })
  app.get('/api/ping', async () => ({ pong: true }))
  await registerApi(app, {
    config, configPath, db, mirrorDirFor, schedulers, sse,
    addScheduler, removeScheduler,
    adapter: options.adapter ?? nullAdapter
  })

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
    schedulers.forEach(s => s.stop())
    // hijack 的 SSE 流对 Fastify 非 idle，app.close() 只清 idle 连接会永久悬挂；
    // 先同步销毁全部 SSE 客户端再走正常关闭
    sse.closeAll()
    await app.close()
    db.close()
  }
  return { app, config, configPath, schedulers, sse, close }
}
