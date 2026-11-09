import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Repos from '../src/views/Repos.vue'

const reposPayload = [
  { id: 'r1', url: 'https://github.com/x/r1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 }
]
const statusPayload = {
  state: 'running', lastRunAt: 1, nextRunAt: 2, consecutiveFailures: 0,
  lastError: null, lastNewCommits: 0, mirrorDir: '/m', lastFetch: null
}

interface FetchOpts { postResult?: { ok: boolean; json: unknown }; patchResult?: { ok: boolean; json: unknown } }

// 按方法/路径路由的 fetch 桩（CommitDetail/CrossRepo 同款 memory router + stub 模式），记录全部调用供载荷断言
function stubFetch(opts: FetchOpts = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const r = opts.postResult ?? { ok: true, json: { id: 'beta', url: 'u', defaultBranch: 'master', pollIntervalSeconds: 30 } }
      return { ok: r.ok, json: async () => r.json }
    }
    if (init?.method === 'PATCH') {
      // 默认回 PATCH 更新后的仓行（与 server 契约同形：五字段）
      const r = opts.patchResult ?? { ok: true, json: reposPayload[0] }
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

    // 审查 C1：'..'/'.' 过白名单正则，但服务端 mirrorDir 会逃逸 → 前端同款先行拦截
    await id().setValue('..')
    await add()
    expect(wrapper.find('.banner-red').text()).toContain('id 不能为')

    await id().setValue('beta')
    await url().setValue('')
    await add()
    expect(wrapper.find('.banner-red').text()).toContain('url 不能为空')

    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'POST')).toBe(false)
  })

  it('编辑按钮进入行内编辑态：url 只读无输入框带提示；保存发 PATCH 三键载荷并刷新', async () => {
    const { wrapper, fetchMock } = await mountView()
    const editBtn = wrapper.findAll('button').find(b => b.text() === '编辑')
    expect(editBtn).toBeDefined()   // RED：行内无编辑按钮
    await editBtn!.trigger('click')

    // 编辑控件出现；url 保持只读文本（编辑态不加输入框）并带不可修改 title 提示
    expect(wrapper.find('.edit-branch').exists()).toBe(true)
    expect(wrapper.find('.edit-interval').exists()).toBe(true)
    expect(wrapper.find('.edit-exclude').exists()).toBe(true)
    const urlCell = wrapper.find('td.url-cell')
    expect(urlCell.find('input').exists()).toBe(false)
    expect(urlCell.attributes('title')).toContain('url 不可修改')

    // 预填为当前行值
    expect((wrapper.find('.edit-branch').element as HTMLInputElement).value).toBe('main')
    expect((wrapper.find('.edit-interval').element as HTMLInputElement).value).toBe('30')

    await wrapper.find('.edit-branch').setValue('develop')
    await wrapper.find('.edit-interval').setValue('7')
    await wrapper.find('.edit-exclude').setValue('tmp/**, dist/**')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()

    const calls = fetchMock.mock.calls
    const i = calls.findIndex(c => methodOf(c) === 'PATCH')
    expect(i).toBeGreaterThan(-1)
    expect(urlOf(calls[i])).toBe('/api/repos/r1')
    // 载荷仅三键白名单（无 url/id）；排除 glob 逗号拆分为字符串数组
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 7, defaultBranch: 'develop', branchExclude: ['tmp/**', 'dist/**']
    })
    // 保存成功 → 退出编辑态 + 刷新列表（PATCH 之后再次 GET /api/repos）
    expect(wrapper.find('.edit-branch').exists()).toBe(false)
    expect(calls.slice(i + 1).some(c => urlOf(c) === '/api/repos')).toBe(true)
  })

  it('PATCH 400 → 错误横幅透出服务端 message 且留在编辑态；取消退出且不发请求', async () => {
    const { wrapper, fetchMock } = await mountView({
      patchResult: { ok: false, json: { code: 'invalid', message: 'pollIntervalSeconds: 需为 ≥5 的整数' } }
    })
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()

    const banner = wrapper.find('.banner-red')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('pollIntervalSeconds: 需为 ≥5 的整数')   // message 优先 code 兜底
    expect(wrapper.find('.edit-branch').exists()).toBe(true)   // 失败留在编辑态，可改后重试
    expect(fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')).toHaveLength(1)

    await wrapper.findAll('button').find(b => b.text() === '取消')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.edit-branch').exists()).toBe(false)  // 取消退出编辑态
    expect(wrapper.find('.banner-red').exists()).toBe(false)   // 顺带清掉横幅
    // 取消不触发任何请求：PATCH 仍只有此前失败的 1 次
    expect(fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')).toHaveLength(1)
  })

  it('前端先行校验：间隔非 ≥5 整数 / 分支为空拦在本地，不发出 PATCH', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    const save = async (): Promise<void> => {
      await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
      await flushPromises()
    }

    await wrapper.find('.edit-interval').setValue('0')
    await save()
    expect(wrapper.find('.banner-red').text()).toContain('轮询间隔须为不小于 5 的整数秒')

    await wrapper.find('.edit-interval').setValue('7.5')
    await save()
    expect(wrapper.find('.banner-red').text()).toContain('轮询间隔须为不小于 5 的整数秒')

    await wrapper.find('.edit-interval').setValue('7')
    await wrapper.find('.edit-branch').setValue('  ')
    await save()
    expect(wrapper.find('.banner-red').text()).toContain('默认分支不能为空')

    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)
  })
})
