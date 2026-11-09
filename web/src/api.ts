export interface CommitRow {
  sha: string
  authorName: string | null
  authorEmail: string | null
  committedAt: number
  subject: string | null
  body: string | null
  firstSeenBranch: string | null
}

export interface BranchRow {
  name: string
  status: 'active' | 'deleted'
  headSha: string | null
  lastSubject: string | null
  lastAuthor: string | null
  lastCommitAt: number | null
  behindDefault: number | null
  rewritten: boolean
  recentCommits: number
}

export type InclusionStatus = 'active' | 'deleted' | 'rewritten'
export interface InclusionRow { branch: string; contains: boolean; status: InclusionStatus }

export interface StatusDto {
  state: 'starting' | 'running' | 'idle' | 'backoff'
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveFailures: number
  lastError: string | null
  lastNewCommits: number | null
  mirrorDir: string
  lastFetch: { status: string; started_at: number; finished_at: number | null; error: string | null } | null
}

export interface CompareDto {
  ahead: number
  behind: number
  aheadCommits: CommitRow[]
  behindCommits: CommitRow[]
}

// GET /api/repos 响应行：branchExclude 为服务端回读字段（UI 配置的排除 glob 可见）。
// v1.3.2 传输兜底两字段回读：bypassGitConfig 恒在（default false），但 DTO 保持 optional——
// T1 裁定 GET 行 httpProxy 未设时省键（undefined=跟随系统 git 配置），读侧一律 `?? false`
// / `'httpProxy' in r` 形态兜底，形状漂移时 typecheck 门兜住
export interface RepoDto {
  id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number
  bypassGitConfig?: boolean
  httpProxy?: string
}

// v1.3 仓库生命周期：POST /api/repos 请求体。可选字段缺省 = 服务端 zod default（master/[]/30），
// 前端按同款契约先行校验（id 白名单、url 非空）拦必败请求，服务端仍是唯一裁决
export interface RepoConfigDto {
  id: string
  url: string
  defaultBranch?: string
  branchExclude?: string[]
  pollIntervalSeconds?: number
  // v1.3.2 传输兜底：POST 载荷 bypassGitConfig 恒带 boolean；httpProxy 三分支语义
  // （undefined=跟随系统 git 配置，''=强制无代理，非空=显式代理），见 RepoDto 注
  bypassGitConfig?: boolean
  httpProxy?: string
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json() as Promise<T>
}

// 非 GET 请求共用：错误体为 { code, message? }——message 透传（400 校验详情/500 写失败），
// 缺省回退 code（409 repo_exists 无 message），再缺退 HTTP 状态
async function sendJson<T>(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { code?: string; message?: string } | null
    throw new Error(payload?.message ?? payload?.code ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export interface CrossBranchesDto {
  repoA: { id: string; branches: string[] }
  repoB: { id: string; branches: string[] }
  paired: string[]
  unpairedA: string[]
  unpairedB: string[]
}
export interface CrossCompareDto {
  branchPair: { repoA: string; branchA: string; repoB: string; branchB: string }
  onlyInA: CommitRow[]
  onlyInB: CommitRow[]
  matchedPairs: { patchId: string; shaA: string; shaB: string; subjectA: string }[]
  unpairedBranches: { repoA: string[]; repoB: string[] }
  stats: { aTotal: number; bTotal: number; matched: number; onlyA: number; onlyB: number }
}

// repo 可选作用域：缺省取服务端第一仓（与 server 端 resolveRepo 语义一致）；
// path 已带查询串时用 & 续接（compare 先例），否则用 ? 起头
const withRepo = (path: string, repo?: string): string =>
  repo ? `${path}${path.includes('?') ? '&' : '?'}repo=${encodeURIComponent(repo)}` : path

export const api = {
  status: (repo?: string): Promise<StatusDto> => getJson(withRepo('/api/status', repo)),
  repos: (): Promise<RepoDto[]> => getJson('/api/repos'),
  branches: (repo?: string): Promise<BranchRow[]> => getJson(withRepo('/api/branches', repo)),
  branchCommits: (branch: string, limit = 100, repo?: string): Promise<CommitRow[]> => {
    const u = new URLSearchParams({ branch, limit: String(limit) })
    if (repo) u.set('repo', repo)
    return getJson(`/api/commits?${u.toString()}`)
  },
  commitInclusion: (sha: string, repo?: string): Promise<{ commit: CommitRow; results: InclusionRow[] }> =>
    getJson(withRepo(`/api/commits/${sha}/inclusion`, repo)),
  compare: (base: string, target: string, repo?: string): Promise<CompareDto> =>
    getJson(withRepo(`/api/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`, repo)),
  crossBranches: (repoA: string, repoB: string): Promise<CrossBranchesDto> =>
    getJson(`/api/crossrepo/branches?repoA=${encodeURIComponent(repoA)}&repoB=${encodeURIComponent(repoB)}`),
  crossCompare: (p: { repoA: string; repoB: string; branchA: string; branchB: string; include?: string[]; exclude?: string[] }): Promise<CrossCompareDto> => {
    const u = new URLSearchParams({ repoA: p.repoA, repoB: p.repoB, branchA: p.branchA, branchB: p.branchB })
    if (p.include?.length) u.set('include', p.include.join(','))
    if (p.exclude?.length) u.set('exclude', p.exclude.join(','))
    return getJson(`/api/crossrepo/compare?${u.toString()}`)
  },
  // 仓库生命周期（契约见 server/test/reposapi.test.ts）：201 返回全字段仓；400/409/500 抛 message/code
  addRepo: (body: RepoConfigDto): Promise<RepoDto> => sendJson('/api/repos', 'POST', body),
  // id 进路径：encodeURIComponent 纪律（与 withRepo 查询串转义同源）
  removeRepo: (id: string): Promise<{ ok: true }> => sendJson(`/api/repos/${encodeURIComponent(id)}`, 'DELETE'),
  // 行内编辑（v1.3.1）：PATCH 成功返回与 GET /api/repos 行同形的五字段；错误走 sendJson 通道
  // message 优先、code 兜底（400 invalid 透传校验详情 / 500 config_write_failed）
  updateRepo: (id: string, patch: RepoPatchDto): Promise<RepoDto> =>
    sendJson(`/api/repos/${encodeURIComponent(id)}`, 'PATCH', patch),
  // 手动同步（v1.3.2）：POST /api/repos/:id/sync。服务端始终 200、结果经载荷表达
  // （契约见 server/test/reposapi.test.ts）；HTTP 非 200/网络错走 sendJson 通道抛 message
  syncRepo: (id: string): Promise<SyncResultDto> =>
    sendJson(`/api/repos/${encodeURIComponent(id)}/sync`, 'POST')
}

// v1.3.2 手动同步响应：ok=false → error；skipped=true → 自动轮询在飞被互斥跳过（message 为文案）；
// ok=true → newCommits 检出数
export interface SyncResultDto {
  ok: boolean
  skipped?: boolean
  newCommits?: number
  error?: string
  message?: string
}

// v1.3.1 行内编辑：PATCH /api/repos/:id 请求体 = 五键白名单（契约见 server/test/reposapi.test.ts）。
// url/id 是仓的身份键，服务端一票拒绝（url_immutable），前端载荷也绝不携带。
// v1.3.2 传输兜底两键入白名单：bypassGitConfig 恒带 boolean；httpProxy 省键=不改动
// （服务端仅更新提供的键——"未设=跟随系统"语义在 PATCH 侧即保持现状）
export interface RepoPatchDto {
  pollIntervalSeconds?: number
  defaultBranch?: string
  branchExclude?: string[]
  bypassGitConfig?: boolean
  httpProxy?: string
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

// 与 formatRelative 对偶：面向未来时间戳（如调度器 nextRunAt 倒计时）
export function formatFuture(ts: number, now = Date.now()): string {
  const diff = Math.max(0, ts - now)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 1) return '刚刚'
  if (seconds < 60) return `${seconds} 秒后`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时后`
  return '稍后'
}

// v1.1-T1 起 SSE 载荷带 repoId（多仓）：commits.new 增字段，branches.updated/status.changed 增包
export interface CommitsNewEvent { repoId: string; branch: string; count: number; subjects: string[] }
export interface BranchesUpdatedEvent { repoId: string }
// status.changed 载荷 = server SchedulerStatus（server/src/scheduler.ts）+ repoId（app.ts publish 时并入），
// 与 REST /api/status 的 StatusDto 相比无 mirrorDir/lastFetch——调度器推送不含镜像路径/最近 fetch 详情
export type StatusChangedEvent = Pick<
  StatusDto, 'state' | 'lastRunAt' | 'nextRunAt' | 'consecutiveFailures' | 'lastError' | 'lastNewCommits'
> & { repoId: string }

export interface EventHandlers {
  onCommitsNew?: (data: CommitsNewEvent) => void
  onBranchesUpdated?: (data: BranchesUpdatedEvent) => void
  onStatus?: (data: StatusChangedEvent) => void
}

export function connectEvents(handlers: EventHandlers): EventSource {
  const es = new EventSource('/api/events')
  const bind = <T>(type: string, fn?: (data: T) => void): void => {
    if (!fn) return
    es.addEventListener(type, e => fn(JSON.parse((e as MessageEvent).data) as T))
  }
  bind('commits.new', handlers.onCommitsNew)
  bind('branches.updated', handlers.onBranchesUpdated)
  bind('status.changed', handlers.onStatus)
  return es
}
