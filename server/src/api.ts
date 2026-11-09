import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { MAX_POLL_INTERVAL_SECONDS, repoSchema, updateRepoFields, writeConfig, type AppConfig, type RepoConfig } from './config.js'
import type { Scheduler } from './scheduler.js'
import type { SseHub } from './sse.js'
import type { PlatformAdapter } from './platform/types.js'
import { GitCommandError } from './gitRunner.js'
import { crossCompare } from './crossrepo.js'
import { aheadBehind, compareBranches, inclusionForCommit, type BranchStatus } from './analyzer.js'
import { listCommits } from './sync.js'
import type { CommitInfo } from './parse.js'

interface BranchDbRow {
  name: string; status: string; head_sha: string | null; rewritten_at: number | null
}
interface CommitDbRow {
  sha: string; author_name: string | null; author_email: string | null
  committed_at: number; subject: string | null; body: string | null; first_seen_branch: string | null
}

export interface ApiDeps {
  config: AppConfig
  /** config.json 实际路径：POST/DELETE 经 writeConfig 原子回写的目标 */
  configPath: string
  db: Database.Database
  mirrorDirFor(repoId: string): string
  schedulers: Scheduler[]
  /** API 挂新仓（构造 + start，免重启） */
  addScheduler(repo: RepoConfig): Scheduler
  /** API 摘仓（按 repoId stop + 出列） */
  removeScheduler(id: string): void
  sse: SseHub
  adapter: PlatformAdapter
}

function mapCommit(r: CommitDbRow): Record<string, unknown> {
  return {
    sha: r.sha, authorName: r.author_name, authorEmail: r.author_email,
    committedAt: r.committed_at, subject: r.subject, body: r.body, firstSeenBranch: r.first_seen_branch
  }
}

// listCommits 返回镜像侧 CommitInfo（camelCase），适配为 mapCommit 的 DB 行形状；
// 镜像列表不经 DB，first_seen_branch 置 null 表示"此处无从给出"
function toDbRowShape(c: CommitInfo): CommitDbRow {
  return {
    sha: c.sha, author_name: c.authorName, author_email: c.authorEmail,
    committed_at: c.committedAt, subject: c.subject, body: c.body, first_seen_branch: null
  }
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, config, schedulers } = deps

  // repo 作用域：?repo= 指定仓（app.ts 装配保证 schedulers 与 config.repos 同序同长）；
  // 缺省取第一个仓，未知 id → null（端点统一回 404 repo_not_found）
  function resolveRepo(qRepo: string | undefined): RepoConfig | null {
    if (!qRepo) return config.repos[0]
    return config.repos.find(r => r.id === qRepo) ?? null
  }

  app.get('/api/status', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const mirrorDir = deps.mirrorDirFor(repo.id)
    const lastFetch = db.prepare(`SELECT * FROM fetch_events WHERE repo_id=? ORDER BY id DESC LIMIT 1`).get(repo.id) ?? null
    return { repoId: repo.id, ...schedulers[config.repos.indexOf(repo)].status, mirrorDir, lastFetch }
  })

  app.get('/api/repos', async () =>
    // branchExclude 与传输兜底两字段一并暴露：UI 配置的排除 glob/直连/代理需可回读查看；
    // httpProxy 未设时 undefined → JSON 省键（fix round 1 三分支语义：未设=跟随系统 git 配置）
    config.repos.map(({ id, url, defaultBranch, branchExclude, pollIntervalSeconds, bypassGitConfig, httpProxy }) =>
      ({ id, url, defaultBranch, branchExclude, pollIntervalSeconds, bypassGitConfig, httpProxy })
    )
  )

  // —— 仓库生命周期：界面上直接配置仓库，免重启生效（v1.3 Task 1） ——

  // 单仓校验用导出的 repoSchema（不等同于整体 configSchema 的 min(1)/唯一性 refine）
  app.post('/api/repos', async (req, reply) => {
    const parsed = repoSchema.safeParse(req.body)
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
      return reply.code(400).send({ code: 'invalid', message: detail })
    }
    const repo = parsed.data
    if (config.repos.some(r => r.id === repo.id)) {
      return reply.code(409).send({ code: 'repo_exists' })
    }
    config.repos.push(repo)
    try {
      writeConfig(deps.configPath, config)
    } catch (e) {
      config.repos.pop()   // 回滚内存，保持 config 与磁盘一致
      return reply.code(500).send({ code: 'config_write_failed', message: (e as Error).message })
    }
    // repos 行是 branches/commits 外键宿主，须先于 addScheduler 登记，否则首跑回填即 FK 失败；
    // upsert 语句与 app.ts 启动装配一致：同 id 重挂（曾 DELETE 的仓）更新 url/default_branch、
    // created_at 保留，branches/commits 历史自动接续（INSERT OR IGNORE 语义）
    db.prepare(
      `INSERT INTO repos (id, url, default_branch, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET url=excluded.url, default_branch=excluded.default_branch`
    ).run(repo.id, repo.url, repo.defaultBranch, Date.now())
    deps.addScheduler(repo)
    return reply.code(201).send(repo)
  })

  app.delete('/api/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const i = config.repos.findIndex(r => r.id === id)
    if (i === -1) return reply.code(404).send({ code: 'repo_not_found' })
    // configSchema repos min(1) 的运行时保底（审查 I1）：删掉唯一仓会落盘 repos:[]，
    // 重启时 loadConfig 直接抛错、index.ts 顶层 await 崩溃，只能手编 config 救活
    if (config.repos.length === 1) {
      return reply.code(409).send({ code: 'last_repo', message: '至少保留一个仓库' })
    }
    const [removed] = config.repos.splice(i, 1)
    try {
      writeConfig(deps.configPath, config)
    } catch (e) {
      config.repos.splice(i, 0, removed)   // 回滚内存，保持 config 与磁盘一致
      return reply.code(500).send({ code: 'config_write_failed', message: (e as Error).message })
    }
    // 只摘调度与配置：DB repos 行与 branches/commits 历史有意保留——同 id 重挂时
    // 启动/POST 装配的 ON CONFLICT upsert 命中已有行，历史接续，不视为删除数据
    deps.removeScheduler(id)
    return { ok: true }
  })

  // PATCH：轮询间隔等属性运行时调整（v1.3.1）。核心是**原位变更**语义——config.repos
  // 中的仓对象被 Scheduler.deps.repo 持同引用（app.ts 装配传入同一对象），updateRepoFields
  // 只改字段不换对象，下一轮询周期即按新 pollIntervalSeconds 调度，defaultBranch/branchExclude
  // 下一 fetch 周期生效；整体替换对象（splice/新对象）会静默断开调度器引用，严禁。
  app.patch('/api/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const repo = config.repos.find(r => r.id === id)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
    // url/id 是仓的身份键（镜像目录名/调度器标识/API ?repo= 取值），替换即断链或串仓——
    // 出现即拒绝（哪怕值与现状相同），换地址的唯一途径是删除后重新添加
    if ('url' in body || 'id' in body) {
      return reply.code(400).send({
        code: 'url_immutable',
        message: 'url 不可修改，请删除后重新添加以更换地址'
      })
    }
    // 逐字段值校验（与 repoSchema 同阈值：整数 ≥5 / 非空字符串 / 字符串数组 / boolean / string），
    // 透传 invalid
    const patch: {
      pollIntervalSeconds?: number; defaultBranch?: string; branchExclude?: string[]
      bypassGitConfig?: boolean; httpProxy?: string
    } = {}
    const issues: string[] = []
    if (body.pollIntervalSeconds !== undefined) {
      const n = body.pollIntervalSeconds
      if (typeof n === 'number' && Number.isInteger(n) && n >= 5 && n <= MAX_POLL_INTERVAL_SECONDS) {
        patch.pollIntervalSeconds = n
      } else if (typeof n === 'number' && n > MAX_POLL_INTERVAL_SECONDS) {
        // 超上界单独文案（与 repoSchema .max 同阈值）：604800 以上 setTimeout 会被钳成
        // 1ms 紧循环，必须在此拒绝，防运行时把调度器打爆远端
        issues.push(`pollIntervalSeconds: 轮询间隔上限 ${MAX_POLL_INTERVAL_SECONDS} 秒（7 天）`)
      } else {
        issues.push('pollIntervalSeconds: 需为 ≥5 的整数')
      }
    }
    if (body.defaultBranch !== undefined) {
      if (typeof body.defaultBranch === 'string' && body.defaultBranch.length > 0) {
        patch.defaultBranch = body.defaultBranch
      } else {
        issues.push('defaultBranch: 需为非空字符串')
      }
    }
    if (body.branchExclude !== undefined) {
      if (Array.isArray(body.branchExclude) && body.branchExclude.every(x => typeof x === 'string')) {
        patch.branchExclude = body.branchExclude
      } else {
        issues.push('branchExclude: 需为字符串数组')
      }
    }
    if (body.bypassGitConfig !== undefined) {
      if (typeof body.bypassGitConfig === 'boolean') {
        patch.bypassGitConfig = body.bypassGitConfig
      } else {
        issues.push('bypassGitConfig: 需为布尔值')
      }
    }
    if (body.httpProxy !== undefined) {
      // 空串合法 = 强制无代理（显式覆盖劫持的全局代理），与 repoSchema z.string() 同阈值；
      // 键缺省走不到这里（undefined 不落对象，"未设=跟随系统"语义得以保留）
      if (typeof body.httpProxy === 'string') {
        patch.httpProxy = body.httpProxy
      } else {
        issues.push('httpProxy: 需为字符串')
      }
    }
    if (issues.length > 0) {
      return reply.code(400).send({ code: 'invalid', message: issues.join('; ') })
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({
        code: 'no_fields',
        message: '无可更新字段（仅允许 pollIntervalSeconds/defaultBranch/branchExclude/bypassGitConfig/httpProxy）'
      })
    }
    // 回滚纪律同 POST/DELETE：变更前 snapshot 旧五字段，writeConfig 失败 → 原位 assign 回旧值
    // （仍是同一对象，调度器引用不断）+ 500，保持 config 内存与磁盘一致
    const snapshot = {
      pollIntervalSeconds: repo.pollIntervalSeconds,
      defaultBranch: repo.defaultBranch,
      branchExclude: repo.branchExclude,
      bypassGitConfig: repo.bypassGitConfig,
      httpProxy: repo.httpProxy
    }
    updateRepoFields(repo, patch)
    try {
      writeConfig(deps.configPath, config)
    } catch (e) {
      updateRepoFields(repo, snapshot)
      return reply.code(500).send({ code: 'config_write_failed', message: (e as Error).message })
    }
    // DB repos 行同步 default_branch：沿用 v1.3 装配/POST 的 upsert 语句形态（url/created_at 不动，
    // ON CONFLICT 命中挂载时登记的行）。branchExclude 不同步 DB——repos 表无该列（v1.3 schema 即如此），
    // 其持久层是 config.json，运行时生效路径是原位变更后的共享对象
    db.prepare(
      `INSERT INTO repos (id, url, default_branch, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET default_branch=excluded.default_branch`
    ).run(repo.id, repo.url, repo.defaultBranch, Date.now())
    // 返回形状与 GET /api/repos 行一致（七个字段）
    return {
      id: repo.id, url: repo.url, defaultBranch: repo.defaultBranch,
      branchExclude: repo.branchExclude, pollIntervalSeconds: repo.pollIntervalSeconds,
      bypassGitConfig: repo.bypassGitConfig, httpProxy: repo.httpProxy
    }
  })

  // —— 手动同步（v1.3.2 追加需求）：把调度器的一轮 fetch 暴露为界面能力 ——

  // 语义：runOnce 自带互斥守卫（自动轮询在飞 → skipped:true，端点与自动 loop 天然共存）；
  // 始终 200，结果经载荷表达：检出数 / 进行中跳过 / 失败 error 透传；
  // 未知仓与无调度器 → 404 repo_not_found（与 GET /api/status?repo= 未知 id 同款）
  app.post('/api/repos/:id/sync', async (req, reply) => {
    const { id } = req.params as { id: string }
    const repo = config.repos.find(r => r.id === id)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const s = schedulers.find(sc => sc.repoId === repo.id)
    if (!s) return reply.code(404).send({ code: 'repo_not_found' })
    const r = await s.runOnce()
    if (r.skipped) return { ok: true, skipped: true, message: '已有同步在进行中' }
    if (r.error) return { ok: false, error: r.error }
    return { ok: true, newCommits: r.newCommits ?? 0 }
  })

  app.get('/api/branches', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const mirrorDir = deps.mirrorDirFor(repo.id)
    const rows = db.prepare(`SELECT * FROM branches WHERE repo_id=? ORDER BY name`).all(repo.id) as BranchDbRow[]
    const now = Date.now()
    const out = []
    for (const r of rows) {
      const head = r.head_sha
        ? db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, r.head_sha) as CommitDbRow | undefined
        : undefined
      let behindDefault: number | null = null
      if (r.status === 'active') {
        try { behindDefault = (await aheadBehind(mirrorDir, repo.defaultBranch, r.name)).ahead }
        catch { behindDefault = null }
      }
      const recent = db.prepare(
        `SELECT COUNT(*) AS n FROM commits WHERE repo_id=? AND first_seen_branch=? AND first_seen_at>?`
      ).get(repo.id, r.name, now - 24 * 3600 * 1000) as { n: number }
      out.push({
        name: r.name, status: r.status, headSha: r.head_sha,
        lastSubject: head?.subject ?? null, lastAuthor: head?.author_name ?? null,
        lastCommitAt: head?.committed_at ?? null,
        behindDefault, rewritten: r.rewritten_at != null, recentCommits: recent.n
      })
    }
    return out
  })

  app.get('/api/commits', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const q = req.query as { branch?: string; limit?: string; offset?: string }
    if (!q.branch) return reply.code(400).send({ code: 'bad_request', message: '缺少 branch 参数' })
    // 非法分页参数若放行，NaN 会绕过 --max-count 触发整分支全量 rev-list（可反复打满 CPU），
    // 负数/浮点则让 git 报错伪装成 404；这里统一前置校验
    const limit = q.limit === undefined ? 50 : Number(q.limit)
    const offset = q.offset === undefined ? 0 : Number(q.offset)
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
      return reply.code(400).send({ code: 'bad_request', message: 'limit/offset 需为整数（limit≥1，offset≥0）' })
    }
    try {
      const commits = await listCommits(deps.mirrorDirFor(repo.id), `refs/heads/${q.branch}`, {
        maxCount: limit, skip: offset
      })
      return commits.map(c => mapCommit(toDbRowShape(c)))
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })

  app.get('/api/commits/:sha', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const { sha } = req.params as { sha: string }
    const row = db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, sha) as CommitDbRow | undefined
    if (!row) return reply.code(404).send({ code: 'commit_not_found' })
    const meta = deps.adapter.enrichCommit ? await deps.adapter.enrichCommit(sha) : null
    return { ...mapCommit(row), meta: meta ?? {} }
  })

  app.get('/api/commits/:sha/inclusion', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const { sha } = req.params as { sha: string }
    const row = db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, sha) as CommitDbRow | undefined
    if (!row) return reply.code(404).send({ code: 'commit_not_found' })
    const branchRows = db.prepare(`SELECT name, status, rewritten_at FROM branches WHERE repo_id=?`).all(repo.id) as BranchDbRow[]
    const branches = branchRows.map(b => ({
      name: b.name,
      status: (b.status === 'deleted' ? 'deleted' : b.rewritten_at != null ? 'rewritten' : 'active') as BranchStatus
    }))
    try {
      const results = await inclusionForCommit(deps.mirrorDirFor(repo.id), sha, branches)
      results.sort((a, b) => Number(a.contains) - Number(b.contains))  // 未包含在前
      return { commit: mapCommit(row), results }
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'commit_not_found' })
      throw e
    }
  })

  app.get('/api/compare', async (req, reply) => {
    const repo = resolveRepo((req.query as { repo?: string }).repo)
    if (!repo) return reply.code(404).send({ code: 'repo_not_found' })
    const q = req.query as { base?: string; target?: string }
    if (!q.base || !q.target) return reply.code(400).send({ code: 'bad_request', message: '缺少 base/target 参数' })
    try {
      return await compareBranches(deps.mirrorDirFor(repo.id), q.base, q.target)
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })

  app.get('/api/events', (_req, reply) => {
    deps.sse.add(reply)
  })

  // —— 跨仓对比：把 T2 crossCompare 引擎暴露为 HTTP 契约 ——

  // 同名分支配对：仅 active 分支入库参与配对，ORDER BY name 保证输出稳定
  app.get('/api/crossrepo/branches', async (req, reply) => {
    const q = req.query as { repoA?: string; repoB?: string }
    const [ra, rb] = [resolveRepo(q.repoA), resolveRepo(q.repoB)]
    if (!ra || !rb) return reply.code(404).send({ code: 'repo_not_found' })
    const names = (id: string) => (db.prepare(
      `SELECT name FROM branches WHERE repo_id=? AND status='active' ORDER BY name`).all(id) as { name: string }[]
    ).map(r => r.name)
    const a = names(ra.id); const b = names(rb.id)
    const paired = a.filter(n => b.includes(n))
    return {
      repoA: { id: ra.id, branches: a }, repoB: { id: rb.id, branches: b },
      paired, unpairedA: a.filter(n => !paired.includes(n)), unpairedB: b.filter(n => !paired.includes(n))
    }
  })

  app.get('/api/crossrepo/compare', async (req, reply) => {
    const q = req.query as { repoA?: string; repoB?: string; branchA?: string; branchB?: string; include?: string; exclude?: string }
    if (!q.branchA || !q.branchB) return reply.code(400).send({ code: 'bad_request', message: '缺少 branchA/branchB' })
    const [ra, rb] = [resolveRepo(q.repoA), resolveRepo(q.repoB)]
    if (!ra || !rb) return reply.code(404).send({ code: 'repo_not_found' })
    const split = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean)
    try {
      const result = await crossCompare(
        deps.mirrorDirFor(ra.id), q.branchA, deps.mirrorDirFor(rb.id), q.branchB,
        split(q.include), split(q.exclude)
      )
      const [ba, bb] = [
        (db.prepare(`SELECT name FROM branches WHERE repo_id=? AND status='active' ORDER BY name`).all(ra.id) as { name: string }[]).map(x => x.name),
        (db.prepare(`SELECT name FROM branches WHERE repo_id=? AND status='active' ORDER BY name`).all(rb.id) as { name: string }[]).map(x => x.name)
      ]
      const paired = ba.filter(n => bb.includes(n))
      return {
        branchPair: { repoA: ra.id, branchA: q.branchA, repoB: rb.id, branchB: q.branchB },
        ...result,
        unpairedBranches: {
          repoA: ba.filter(n => !paired.includes(n)),
          repoB: bb.filter(n => !paired.includes(n))
        }
      }
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })
}
