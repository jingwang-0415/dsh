import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectEvents, formatFuture, formatRelative } from '../src/api.js'

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
