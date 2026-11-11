import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Overview from '../src/views/Overview.vue'

// Overview 手动同步按钮（v1.3.2 追加需求）：最小组件测试覆盖按钮→POST→结果横幅分类
// （绿=检出 N / 灰=进行中跳过或无新提交 / 红=失败）+ 请求期 disabled 防连点 + 完成后 refresh。
// 仓库既有分工 Overview 无自动测试文件，此处仅覆盖新增交互，既有展示逻辑仍走人工验收。

const reposPayload = [{ id: 'r1', url: 'u', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 }]
const statusPayload = {
  state: 'idle', lastRunAt: 1, nextRunAt: 2, consecutiveFailures: 0,
  lastError: null, lastNewCommits: 0, mirrorDir: '/m', lastFetch: null
}

class FakeEventSource {
  static last: FakeEventSource | null = null
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(): void {}
  close(): void {}
}

interface FetchOpts {
  syncResult?: { ok: boolean; json: unknown }
  reposList?: { id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number }[]
}

function stubFetch(opts: FetchOpts = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const r = opts.syncResult ?? { ok: true, json: { ok: true, newCommits: 2 } }
      return { ok: r.ok, json: async () => r.json }
    }
    if (url.startsWith('/api/status')) return { ok: true, json: async () => statusPayload }
    if (url.startsWith('/api/branches')) return { ok: true, json: async () => [] }
    if (url === '/api/repos') return { ok: true, json: async () => opts.reposList ?? reposPayload }
    return { ok: true, json: async () => ({}) }
  })
}

async function mountView(opts: FetchOpts = {}, fetchMock?: ReturnType<typeof vi.fn>) {
  const fm = fetchMock ?? stubFetch(opts)
  vi.stubGlobal('fetch', fm)
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Overview }] })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(Overview, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, fetchMock: fm }
}

const syncButton = (wrapper: VueWrapper): DOMWrapper<Element> =>
  wrapper.findAll('button').find(b => b.text() === '立即同步')!

describe('Overview 手动同步按钮（v1.3.2）', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('点击立即同步 → POST /api/repos/r1/sync（当前选中仓）；检出 2 → 绿色横幅 + 完成后 refresh + 按钮恢复', async () => {
    const { wrapper, fetchMock } = await mountView()
    const btn = syncButton(wrapper)
    expect(btn).toBeDefined()   // RED：按钮不存在
    await btn.trigger('click')
    await flushPromises()

    const i = fetchMock.mock.calls.findIndex(c => ((c[1] as RequestInit | undefined)?.method) === 'POST')
    expect(i).toBeGreaterThan(-1)
    expect(fetchMock.mock.calls[i][0]).toBe('/api/repos/r1/sync')

    const note = wrapper.find('.sync-note')
    expect(note.exists()).toBe(true)
    expect(note.classes()).toContain('banner-green')
    expect(note.text()).toContain('手动同步完成：检出 2 个新提交')
    // 完成后 refresh：POST 之后再次 GET /api/repos
    expect(fetchMock.mock.calls.slice(i + 1).some(c => c[0] === '/api/repos')).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()   // 完成后恢复可点
  })

  it('请求期间按钮 disabled（防连点）；skipped → 灰色"已有同步在进行中"', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await gate   // 挂起在飞，制造"请求期间"窗口
        return { ok: true, json: async () => ({ ok: true, skipped: true, message: '已有同步在进行中' }) }
      }
      if (url.startsWith('/api/status')) return { ok: true, json: async () => statusPayload }
      if (url.startsWith('/api/branches')) return { ok: true, json: async () => [] }
      if (url === '/api/repos') return { ok: true, json: async () => reposPayload }
      return { ok: true, json: async () => ({}) }
    })
    const { wrapper } = await mountView({}, fetchMock)
    const btn = syncButton(wrapper)

    const click = btn.trigger('click')
    await flushPromises()
    expect(btn.attributes('disabled')).toBeDefined()   // 在飞禁用（防连点）

    release()
    await click
    await flushPromises()
    const note = wrapper.find('.sync-note')
    expect(note.classes()).toContain('banner-gray')
    expect(note.text()).toContain('已有同步在进行中')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('ok:false → 红色"同步失败：<error>"', async () => {
    const { wrapper } = await mountView({ syncResult: { ok: true, json: { ok: false, error: 'fetch boom' } } })
    await syncButton(wrapper).trigger('click')
    await flushPromises()
    const note = wrapper.find('.sync-note')
    expect(note.classes()).toContain('banner-red')
    expect(note.text()).toContain('同步失败：fetch boom')
  })

  it('sendJson 通道抛错（fetch reject）→ 红色"同步失败：<message>"', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('network boom')
      if (url.startsWith('/api/status')) return { ok: true, json: async () => statusPayload }
      if (url.startsWith('/api/branches')) return { ok: true, json: async () => [] }
      if (url === '/api/repos') return { ok: true, json: async () => reposPayload }
      return { ok: true, json: async () => ({}) }
    })
    const { wrapper } = await mountView({}, fetchMock)
    await syncButton(wrapper).trigger('click')
    await flushPromises()
    const note = wrapper.find('.sync-note')
    expect(note.exists()).toBe(true)
    expect(note.classes()).toContain('banner-red')
    expect(note.text()).toContain('同步失败：network boom')
  })

  it('newCommits=0 → 灰色"手动同步完成：无新提交"', async () => {
    const { wrapper } = await mountView({ syncResult: { ok: true, json: { ok: true, newCommits: 0 } } })
    await syncButton(wrapper).trigger('click')
    await flushPromises()
    const note = wrapper.find('.sync-note')
    expect(note.exists()).toBe(true)
    expect(note.classes()).toContain('banner-gray')
    expect(note.text()).toContain('手动同步完成：无新提交')
  })

  it('在飞切仓：切仓即清横幅；旧仓迟到结果不落新仓语境（守卫不回写）', async () => {
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    let postCount = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1
        if (postCount === 1) return { ok: true, json: async () => ({ ok: true, newCommits: 2 }) }
        await gate   // 第二次 POST 挂起在飞，制造切仓窗口
        return { ok: true, json: async () => ({ ok: true, newCommits: 5 }) }
      }
      if (url.startsWith('/api/status')) return { ok: true, json: async () => statusPayload }
      if (url.startsWith('/api/branches')) return { ok: true, json: async () => [] }
      if (url === '/api/repos') {
        return {
          ok: true,
          json: async () => [
            { id: 'r1', url: 'u', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 },
            { id: 'r2', url: 'u', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 }
          ]
        }
      }
      return { ok: true, json: async () => ({}) }
    })
    const { wrapper } = await mountView({}, fetchMock)
    const btn = syncButton(wrapper)

    // 第一轮：正常完成 → 绿横幅落笔（旧仓语境的既有结果）
    await btn.trigger('click')
    await flushPromises()
    expect(wrapper.find('.sync-note').classes()).toContain('banner-green')

    // 第二轮：在飞（POST 挂起）→ 切仓
    const click = btn.trigger('click')
    await flushPromises()
    await wrapper.findAll('select')[0].setValue('r2')   // onRepoChange：清横幅 + 回写 query + refresh
    await flushPromises()
    expect(wrapper.find('.sync-note').exists()).toBe(false)   // 切仓即清（既有行为保持）

    // 旧仓结果迟到落地：守卫拦截，横幅不得回写到新仓语境
    release()
    await click
    await flushPromises()
    expect(wrapper.find('.sync-note').exists()).toBe(false)   // 守卫（切仓后旧结果不落新仓）
    expect(btn.attributes('disabled')).toBeUndefined()        // finally 仍收敛 syncing
    const posts = fetchMock.mock.calls.filter(c => ((c[1] as RequestInit | undefined)?.method) === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts.every(c => c[0] === '/api/repos/r1/sync')).toBe(true)   // 两次都发往旧仓（发起时捕获）
  })
})
