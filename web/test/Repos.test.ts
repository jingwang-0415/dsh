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
    // v1.3.2 传输两键恒带 boolean/按三分支——默认行无传输配置 → bypassGitConfig:false、
    // 编辑态下拉预填 system → PATCH 显式 httpProxy:null（JSON Merge Patch unset，服务端
    // 对已无该字段的仓 delete 为无操作，幂等；省键承载不了"还原跟随系统"语义故不再省）
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 7, defaultBranch: 'develop', branchExclude: ['tmp/**', 'dist/**'],
      bypassGitConfig: false, httpProxy: null
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

  it('行内编辑输入 Enter 保存：三个编辑输入 keyup.enter 均触发 onSave 发 PATCH', async () => {
    // 覆盖三个可编辑输入（默认分支/轮询间隔/排除 glob）：Enter 与"保存"按钮走同一 onSave 路径
    for (const sel of ['.edit-branch', '.edit-interval', '.edit-exclude']) {
      const { wrapper, fetchMock } = await mountView()
      await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
      await wrapper.find(sel).trigger('keyup.enter')
      await flushPromises()

      const patch = fetchMock.mock.calls.find(c => methodOf(c) === 'PATCH')
      expect(patch).toBeDefined()   // RED：无 Enter 接线时不发 PATCH
      expect(urlOf(patch!)).toBe('/api/repos/r1')
      // 预填值合法 → PATCH 载荷即当前行值；成功后退出编辑态
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
        pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
        bypassGitConfig: false, httpProxy: null
      })
      expect(wrapper.find('.edit-branch').exists()).toBe(false)
    }
  })

  it('网络连接方式：下拉默认跟随系统且三选项齐全（省键/无代理/自定义）', async () => {
    const { wrapper } = await mountView()
    const sel = wrapper.find('.add-proxy-mode')
    expect(sel.exists()).toBe(true)
    expect((sel.element as HTMLSelectElement).value).toBe('system')
    expect(sel.findAll('option').map(o => o.text())).toEqual([
      '跟随系统 git 配置', '强制直连（无代理）', '通过代理服务器连接'
    ])
  })

  it('网络连接方式：勾选绕过系统 git 配置（默认跟随系统）→ POST bypassGitConfig:true 且 httpProxy 省键', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('.add-bypass').setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(call).toBeDefined()
    // bypass 与代理三态正交：仅勾绕过不隐含 httpProxy:''（跟随系统态省键，v1.4 解耦旧直连语义）
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: true
    })
  })

  it('网络连接方式：选强制直连（无代理）→ POST httpProxy:""；该态不渲染代理输入框', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('.add-proxy-mode').setValue('none')
    expect(wrapper.find('.add-proxy').exists()).toBe(false)   // 输入框仅 custom 态显现
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: false, httpProxy: ''
    })
  })

  it('网络连接方式：选通过代理服务器连接但地址为空 → 本地拦截不发 POST；填 http://p:9 → 载荷带值', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    // 跟随系统态不渲染代理输入框；custom 态显现
    expect(wrapper.find('.add-proxy').exists()).toBe(false)
    await wrapper.find('.add-proxy-mode').setValue('custom')
    expect(wrapper.find('.add-proxy').exists()).toBe(true)

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.banner-red').text()).toContain('代理地址不能为空')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'POST')).toBe(false)

    await wrapper.find('.add-proxy').setValue('http://p:9')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: false, httpProxy: 'http://p:9'
    })
  })

  it('表格传输列四态：bypass→直连、httpProxy 非空→代理、""→无代理、省键→—（不再合流）', async () => {
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
    expect(cells[1]).toContain('直连')     // bypass → 直连
    expect(cells[2]).toContain('代理')     // 非空 → 代理
    expect(cells[3]).toContain('无代理')   // httpProxy ''=显式强制无代理（v1.4 四态，不再与 — 合流）
  })

  it('行内编辑网络连接方式：预填映射三态；保存 PATCH 三态载荷（自定义值/强制直连 ""/跟随系统 null 显式 unset）', async () => {
    const { wrapper, fetchMock } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, httpProxy: 'http://old:1' }
      ]
    })
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')

    // 预填映射：httpProxy 非空 → custom 态 + 输入框回填原值；bypass 省键 → unchecked
    expect((wrapper.find('.edit-proxy-mode').element as HTMLSelectElement).value).toBe('custom')
    expect((wrapper.find('.edit-proxy').element as HTMLInputElement).value).toBe('http://old:1')
    expect((wrapper.find('.edit-bypass').element as HTMLInputElement).checked).toBe(false)

    // 第一轮：custom 态改值（未勾绕过）→ PATCH 带 bypassGitConfig:false + httpProxy 新值
    await wrapper.find('.edit-proxy').setValue('http://new:2')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()
    const i = fetchMock.mock.calls.findIndex(c => methodOf(c) === 'PATCH')
    expect(JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: 'http://new:2'
    })

    // 第二轮：切"强制直连（无代理）"（stub 静态回 http://old:1 → 预填仍 custom）→ PATCH httpProxy:''（bypass 独立保持 false）
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    await wrapper.find('.edit-proxy-mode').setValue('none')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()
    const patchCalls = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls).toHaveLength(2)
    expect(JSON.parse(String((patchCalls[1][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: ''
    })

    // 第三轮：切回"跟随系统 git 配置" → PATCH 显式 httpProxy:null（JSON Merge Patch unset——
    // 修复三态编辑缺口：已设代理的仓可经 UI 还原为跟随系统；省键=服务端不改动，不能承载该语义）
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')
    await wrapper.find('.edit-proxy-mode').setValue('system')
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()
    const patchCalls3 = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls3).toHaveLength(3)
    const body3 = JSON.parse(String((patchCalls3[2][1] as RequestInit).body))
    expect(body3).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: null
    })
    expect('httpProxy' in body3).toBe(true)   // 键显式在场且为 null——省键会被服务端理解为"不改动"
  })

  it('行内编辑：省键行预填跟随系统态；选通过代理服务器连接但地址为空 → 本地拦截不发 PATCH', async () => {
    const { wrapper, fetchMock } = await mountView()   // reposPayload r1 无 httpProxy 键
    await wrapper.findAll('button').find(b => b.text() === '编辑')!.trigger('click')

    // 预填映射：省键（undefined=跟随系统）→ system 态且不渲染代理输入框
    expect((wrapper.find('.edit-proxy-mode').element as HTMLSelectElement).value).toBe('system')
    expect(wrapper.find('.edit-proxy').exists()).toBe(false)

    await wrapper.find('.edit-proxy-mode').setValue('custom')
    expect(wrapper.find('.edit-proxy').exists()).toBe(true)   // 仅 custom 态显现
    await wrapper.findAll('button').find(b => b.text() === '保存')!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.banner-red').text()).toContain('代理地址不能为空')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)
  })
})
