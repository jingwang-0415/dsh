import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Repos from '../src/views/Repos.vue'

const reposPayload = [
  { id: 'r1', url: 'https://github.com/x/r1', defaultBranch: 'main', pollIntervalSeconds: 30 }
]
const statusPayload = {
  state: 'running', lastRunAt: 1, nextRunAt: 2, consecutiveFailures: 0,
  lastError: null, lastNewCommits: 0, mirrorDir: '/m', lastFetch: null
}

interface FetchOpts { postResult?: { ok: boolean; json: unknown } }

// 按方法/路径路由的 fetch 桩（CommitDetail/CrossRepo 同款 memory router + stub 模式），记录全部调用供载荷断言
function stubFetch(opts: FetchOpts = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const r = opts.postResult ?? { ok: true, json: { id: 'beta', url: 'u', defaultBranch: 'master', pollIntervalSeconds: 30 } }
      return { ok: r.ok, json: async () => r.json }
    }
    if (init?.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
    if (url.startsWith('/api/status')) return { ok: true, json: async () => statusPayload }
    if (url === '/api/repos') return { ok: true, json: async () => reposPayload }
    return { ok: true, json: async () => ({}) }
  })
}

const methodOf = (call: unknown[]): string => String((call[1] as RequestInit | undefined)?.method ?? 'GET')
const urlOf = (call: unknown[]): string => String(call[0])

async function mountView(opts: FetchOpts = {}) {
  const fetchMock = stubFetch(opts)
  vi.stubGlobal('fetch', fetchMock)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/repos', component: Repos }] })
  await router.push('/repos')
  await router.isReady()
  const wrapper = mount(Repos, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('Repos 视图（仓库管理）', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('添加表单提交 POST 载荷（可选项留空则不带）并刷新列表', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('input[placeholder="master"]').setValue('trunk')
    // jsdom 不实现 submit 按钮点击的隐式表单提交，直接在 form 上派发 submit 事件（与真实点击提交同路径）
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const calls = fetchMock.mock.calls
    const i = calls.findIndex(c => methodOf(c) === 'POST')
    expect(i).toBeGreaterThan(-1)
    expect(urlOf(calls[i])).toBe('/api/repos')
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', defaultBranch: 'trunk'
    })
    // 成功 → 列表刷新：POST 之后再次 GET /api/repos
    expect(calls.slice(i + 1).some(c => urlOf(c) === '/api/repos')).toBe(true)
  })

  it('删除按钮经 confirm 后发 DELETE /api/repos/:id 并刷新；行内展示调度状态徽标', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { wrapper, fetchMock } = await mountView()
    // 状态徽标来自 GET /api/status?repo=r1（state=running → 监听中）
    expect(wrapper.text()).toContain('监听中')

    const del = wrapper.findAll('button').find(b => b.text().includes('删除'))!
    await del.trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalledWith('确定停止监控并移除该仓库？历史数据将保留')
    const calls = fetchMock.mock.calls
    const i = calls.findIndex(c => methodOf(c) === 'DELETE')
    expect(i).toBeGreaterThan(-1)
    expect(urlOf(calls[i])).toBe('/api/repos/r1')
    expect(calls.slice(i + 1).some(c => urlOf(c) === '/api/repos')).toBe(true)
  })

  it('POST 409 → 错误横幅显示服务端冲突文案', async () => {
    const { wrapper } = await mountView({ postResult: { ok: false, json: { code: 'repo_exists' } } })
    await wrapper.find('input[placeholder="repo-id"]').setValue('r1')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const banner = wrapper.find('.banner-red')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('repo_exists')
  })

  it('前端先行校验：非法 id / 空 url 拦截且不发出 POST', async () => {
    const { wrapper, fetchMock } = await mountView()
    const id = (): ReturnType<typeof wrapper.find> => wrapper.find('input[placeholder="repo-id"]')
    const url = (): ReturnType<typeof wrapper.find> => wrapper.find('input[placeholder="https://example.com/beta.git"]')
    const add = async (): Promise<void> => {
      await wrapper.find('form').trigger('submit')   // 同上：jsdom 无按钮隐式提交，直接派发 submit
      await flushPromises()
    }

    await id().setValue('../evil')
    await url().setValue('https://example.com/x.git')
    await add()
    expect(wrapper.find('.banner-red').text()).toContain('id 仅允许字母数字与 . _ -')

    await id().setValue('beta')
    await url().setValue('')
    await add()
    expect(wrapper.find('.banner-red').text()).toContain('url 不能为空')

    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'POST')).toBe(false)
  })
})
