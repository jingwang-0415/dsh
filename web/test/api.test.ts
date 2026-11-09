import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, connectEvents, formatFuture, formatRelative, type CommitsNewEvent, type StatusChangedEvent } from '../src/api.js'

describe('formatRelative', () => {
  const now = 1_700_000_000_000
  it('相对时间分级', () => {
    expect(formatRelative(now - 10_000, now)).toBe('刚刚')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 小时前')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 天前')
  })
})

describe('formatFuture', () => {
  const now = 1_700_000_000_000
  it('未来时间分级，过去时间戳回退刚刚', () => {
    expect(formatFuture(now + 30_000, now)).toBe('30 秒后')
    expect(formatFuture(now + 5 * 60_000, now)).toBe('5 分钟后')
    expect(formatFuture(now + 3 * 3600_000, now)).toBe('3 小时后')
    expect(formatFuture(now + 2 * 86_400_000, now)).toBe('稍后')
    expect(formatFuture(now - 10_000, now)).toBe('刚刚')
  })
})

// repo 作用域契约（与 server resolveRepo 语义一致）：显式 repo 拼进查询串，缺省不出现 repo 参数
describe('repo 作用域请求', () => {
  function stubFetch(): ReturnType<typeof vi.fn<(_url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>> {
    return vi.fn(async (_url: string) => ({ ok: true, json: async () => ({}) }))
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('commitInclusion/compare/branchCommits 显式 repo 拼入查询串', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    await api.commitInclusion('abc', 'r2')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/commits/abc/inclusion?repo=r2')
    await api.compare('main', 'dev', 'r1')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('base=main')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('target=dev')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('repo=r1')
    await api.branchCommits('master', 100, 'r3')
    expect(fetchMock.mock.calls[2]?.[0]).toContain('repo=r3')
  })

  it('缺省 repo 不拼 repo 参数（缺省第一仓由服务端决定）', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    await api.commitInclusion('abc')
    await api.compare('main', 'dev')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/commits/abc/inclusion')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/compare?base=main&target=dev')
  })
})

// 手动同步（v1.3.2 追加需求）：POST /api/repos/:id/sync，id 进路径须转义；
// 载荷结果透传（ok/skipped/newCommits），HTTP 非 200 走 sendJson 通道抛 message
describe('手动同步 api.syncRepo', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('POST 到 /api/repos/:id/sync（id encodeURIComponent），载荷原样返回', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      ({ ok: true, json: async () => ({ ok: true, newCommits: 2 }) }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await api.syncRepo('r1')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/repos/r1/sync')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe('POST')
    expect(r).toEqual({ ok: true, newCommits: 2 })

    // 特殊字符 id 转义纪律（与 removeRepo/updateRepo 同源）
    await api.syncRepo('a/b')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/repos/a%2Fb/sync')
  })

  it('skipped / ok:false 载荷透传；HTTP 404 → 抛服务端 code', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') throw new Error('syncRepo 必须是 POST')
      if (String(_url).includes('busy')) return { ok: true, json: async () => ({ ok: true, skipped: true, message: '已有同步在进行中' }) }
      if (String(_url).includes('fail')) return { ok: true, json: async () => ({ ok: false, error: 'boom' }) }
      return { ok: false, json: async () => ({ code: 'repo_not_found' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await api.syncRepo('busy')).toEqual({ ok: true, skipped: true, message: '已有同步在进行中' })
    expect(await api.syncRepo('fail')).toEqual({ ok: false, error: 'boom' })
    await expect(api.syncRepo('ghost')).rejects.toThrow('repo_not_found')
  })
})

class FakeEventSource {
  static last: FakeEventSource | null = null
  listeners = new Map<string, (e: MessageEvent) => void>()
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { this.listeners.set(type, fn) }
  close(): void {}
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

describe('connectEvents', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('SSE 事件映射到回调', () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    const onCommitsNew = vi.fn()
    const onStatus = vi.fn()
    connectEvents({ onCommitsNew, onStatus })
    const es = FakeEventSource.last!
    expect(es.url).toBe('/api/events')
    // fixture 以导出事件类型标注（真实载荷形状，含 repoId）：形状漂移时 typecheck 门直接报错
    const commitsNew: CommitsNewEvent = { repoId: 'r1', branch: 'master', count: 1, subjects: ['feat: x'] }
    const statusChanged: StatusChangedEvent = {
      repoId: 'r1', state: 'idle', lastRunAt: null, nextRunAt: null,
      consecutiveFailures: 0, lastError: null, lastNewCommits: null
    }
    es.emit('commits.new', commitsNew)
    es.emit('status.changed', statusChanged)
    expect(onCommitsNew).toHaveBeenCalledWith(commitsNew)
    expect(onStatus).toHaveBeenCalledWith(statusChanged)
  })
})
