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

interface RepoRowShape {
  id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number
  bypassGitConfig?: boolean; httpProxy?: string   // T1 裁定：GET 行可能省键（undefined=跟随系统）
}

interface FetchOpts {
  postResult?: { ok: boolean; json: unknown }
  patchResult?: { ok: boolean; json: unknown }
  reposList?: RepoRowShape[]
}

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
    if (url === '/api/repos') return { ok: true, json: async () => opts.reposList ?? reposPayload }
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
    // 载荷：必填两键 + 按需三键 + bypassGitConfig 恒带（v1.3.2）；本例传输字段全默认 →
    // bypassGitConfig:false、httpProxy 省键（跟随系统 git 配置）
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', defaultBranch: 'trunk', bypassGitConfig: false
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
    // 载荷白名单（无 url/id）；排除 glob 逗号拆分为字符串数组；
    // v1.3.2 传输两键恒带 boolean/按三分支——默认行无传输配置 → bypassGitConfig:false、httpProxy 省键
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 7, defaultBranch: 'develop', branchExclude: ['tmp/**', 'dist/**'],
      bypassGitConfig: false
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

  it('前端先行校验：间隔超上限 604801 拦在本地不发 PATCH；下界 5 合法放行', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    const save = async (): Promise<void> => {
      await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
      await flushPromises()
    }

    // 超上界（604800 = 7 天）本地拦截，横幅文案含 604800，零 PATCH 发出
    await wrapper.find('.edit-interval').setValue('604801')
    await save()
    expect(wrapper.find('.banner-red').text()).toContain('604800')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)

    // 下界边界值 5 合法：本地不拦，PATCH 载荷按 5 发出
    await wrapper.find('.edit-interval').setValue('5')
    await save()
    expect(wrapper.find('.banner-red').exists()).toBe(false)
    const patchCall = fetchMock.mock.calls.find(c => methodOf(c) === 'PATCH')
    expect(patchCall).toBeDefined()
    expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toMatchObject({ pollIntervalSeconds: 5 })
  })

  it('传输（高级）：勾选直连且代理留空 → POST 载荷 bypassGitConfig:true + httpProxy:""（强制无代理）', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('.add-bypass').setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(call).toBeDefined()
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: true, httpProxy: ''
    })
  })

  it('传输（高级）：填 http://… 显式代理 → 载荷带 httpProxy 值（未勾直连 bypassGitConfig:false）', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('.add-proxy').setValue('http://127.0.0.1:8080')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: false, httpProxy: 'http://127.0.0.1:8080'
    })
  })

  it('表格传输列：bypassGitConfig→直连徽标、httpProxy 非空→代理徽标、缺省/空串→—', async () => {
    const { wrapper } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 },
        { id: 'r2', url: 'u2', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, bypassGitConfig: true },
        { id: 'r3', url: 'u3', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, httpProxy: 'http://p:1' },
        { id: 'r4', url: 'u4', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, bypassGitConfig: false, httpProxy: '' }
      ]
    })
    const cells = wrapper.findAll('tbody tr').map(row => row.find('.transport-cell').text())
    expect(cells[0]).toBe('—')            // GET 行省键（T1：undefined=跟随系统）→ —
    expect(cells[1]).toContain('直连')
    expect(cells[2]).toContain('代理')
    expect(cells[3]).toBe('—')            // httpProxy ''=强制无代理但非"代理"标记，未勾直连 → —
  })

  it('行内编辑传输字段：预填当前值；保存 PATCH 带 bypassGitConfig/httpProxy（改值与直连空代理两轮）', async () => {
    const { wrapper, fetchMock } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, httpProxy: 'http://old:1' }
      ]
    })
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')

    // 预填：GET 行省 bypassGitConfig 键 → unchecked（?? false 兜底）；httpProxy 键在 → 原值
    expect((wrapper.find('.edit-bypass').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.find('.edit-proxy').element as HTMLInputElement).value).toBe('http://old:1')

    // 第一轮：显式换代理值（未勾直连）→ PATCH 带 bypassGitConfig:false + httpProxy 新值
    await wrapper.find('.edit-proxy').setValue('http://new:2')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()
    const i = fetchMock.mock.calls.findIndex(c => methodOf(c) === 'PATCH')
    expect(JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: 'http://new:2'
    })

    // 第二轮：保存后列表刷新（stub 静态回同一行 → 预填回 http://old:1）→ 清空代理、勾直连
    // → httpProxy:''（直连+留空 = 强制无代理分支）
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    await wrapper.find('.edit-proxy').setValue('')
    await wrapper.find('.edit-bypass').setValue(true)
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()
    const patchCalls = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls).toHaveLength(2)
    expect(JSON.parse(String((patchCalls[1][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: true, httpProxy: ''
    })
  })
})
