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

export interface RepoDto { id: string; url: string; defaultBranch: string; pollIntervalSeconds: number }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
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
  }
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
export type StatusChangedEvent = StatusDto & { repoId: string }

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
