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

export const api = {
  status: (): Promise<StatusDto> => getJson('/api/status'),
  repos: (): Promise<RepoDto[]> => getJson('/api/repos'),
  branches: (): Promise<BranchRow[]> => getJson('/api/branches'),
  branchCommits: (branch: string, limit = 100): Promise<CommitRow[]> =>
    getJson(`/api/commits?branch=${encodeURIComponent(branch)}&limit=${limit}`),
  commitInclusion: (sha: string): Promise<{ commit: CommitRow; results: InclusionRow[] }> =>
    getJson(`/api/commits/${sha}/inclusion`),
  compare: (base: string, target: string): Promise<CompareDto> =>
    getJson(`/api/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`)
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

export interface EventHandlers {
  onCommitsNew?: (data: { branch: string; count: number; subjects: string[] }) => void
  onBranchesUpdated?: () => void
  onStatus?: (data: StatusDto) => void
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
