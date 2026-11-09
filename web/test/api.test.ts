import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, connectEvents, formatFuture, formatRelative } from '../src/api.js'

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
    es.emit('commits.new', { branch: 'master', count: 1 })
    es.emit('status.changed', { state: 'idle' })
    expect(onCommitsNew).toHaveBeenCalledWith({ branch: 'master', count: 1 })
    expect(onStatus).toHaveBeenCalledWith({ state: 'idle' })
  })
})
