import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Repos from '../src/views/Repos.vue'

// v1.6-T2 Element Plus 迁移：DOM 定位适配 EP 结构（el-form/el-input/el-select/el-checkbox/
// el-table/el-popconfirm/el-tag/el-alert），业务断言逐字保留（POST/PATCH 载荷键值/URL/
// 状态分支/三分支语义/互斥联动）。探针实证（zz-probe，临时文件不提交）：
// - VTU 默认 stub transition 会吞掉 el-tag 根节点 → mount 统一 stubs.transition=false
// - el-table mounted 依赖 ResizeObserver（jsdom 无）→ mountView 内 stubGlobal
// - el-select :teleported="false" → 选项渲染在组件根内可作用域查询，未展开亦可直接点击选项完成选择
// - el-popconfirm：默认 teleport 到 document.body，必须显式 confirm/cancel-button-text（默认 Yes/No）
// - el-input/el-checkbox：class 落 wrapper，原生 input 用 `.class input` 定位（setValue/checked/disabled）

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
  gitConfigPath?: string                          // v1.5：未设省键（undefined=使用机器级全局配置）
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
      // 默认回 PATCH 更新后的仓行（与 server 契约同形：基础字段，可选传输键可省）
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

const RO_STUB = class { observe(): void {} unobserve(): void {} disconnect(): void {} }

async function mountView(opts: FetchOpts = {}) {
  const fetchMock = stubFetch(opts)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', RO_STUB)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/repos', component: Repos }] })
  await router.push('/repos')
  await router.isReady()
  const wrapper = mount(Repos, { global: { plugins: [router], stubs: { transition: false } } })
  await flushPromises()
  return { wrapper, fetchMock }
}

// el-select（teleported=false）作用域内按文案点选项（探针：未展开亦可直接选中并触发 change）
async function pickOption(wrapper: VueWrapper, sel: string, label: string): Promise<void> {
  const item = wrapper
    .findAll(`${sel} .el-select-dropdown__item`)
    .find(i => i.text() === label)
  expect(item, `下拉选项「${label}」应存在于 ${sel}`).toBeDefined()
  await item!.trigger('click')
  await flushPromises()
}

// 表格内按钮一律收敛到 tbody 定位（探针实证：el-table-column 会在 .hidden-columns 以哑上下文
// { row: {} } 额外渲染一次列默认插槽——影子克隆里的按钮不带真实行数据，全文查找必须避开）
const cellButton = (wrapper: VueWrapper, text: string): DOMWrapper<Element> | undefined =>
  wrapper.findAll('tbody tr button').find(b => b.text() === text)

// el-popconfirm（默认 teleport 到 body）：点开引用按钮 → 返回 popper 元素
async function openPopconfirm(wrapper: VueWrapper, btnText: string): Promise<HTMLElement> {
  const btn = wrapper.findAll('tbody tr button').find(b => b.text() === btnText)
  expect(btn, `按钮「${btnText}」应存在`).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
  await new Promise(r => setTimeout(r, 10))   // 探针实证：popper 挂载需一个宏任务间隙
  const pop = document.querySelector('.el-popper.el-popover') as HTMLElement | null
  expect(pop, 'popconfirm 弹层应渲染').not.toBeNull()
  return pop!
}

const popAction = (pop: HTMLElement, label: string): HTMLElement => {
  const btn = Array.from(pop.querySelectorAll<HTMLElement>('.el-popconfirm__action button'))
    .find(b => b.textContent?.trim() === label)
  expect(btn, `popconfirm 按钮「${label}」应存在`).toBeDefined()
  return btn!
}

describe('Repos 视图（仓库管理，EP 迁移适配）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.querySelectorAll('.el-popper').forEach(n => n.remove())   // popper 不跨用例串扰
    document.querySelectorAll('.el-message').forEach(n => n.remove())
  })

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

  it('删除按钮经 popconfirm 确认后发 DELETE /api/repos/:id 并刷新；行内展示调度状态徽标；取消不发请求', async () => {
    const { wrapper, fetchMock } = await mountView()
    // 状态徽标来自 GET /api/status?repo=r1（state=running → 监听中，el-tag 渲染）
    expect(wrapper.text()).toContain('监听中')

    // 取消分支：popconfirm 文案（替代 window.confirm 断言）→ 取消 → 无 DELETE
    const pop1 = await openPopconfirm(wrapper, '删除')
    expect(pop1.textContent).toContain('确定停止监控并移除该仓库？历史数据将保留')
    popAction(pop1, '取消').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'DELETE')).toBe(false)

    // 确认分支：DELETE /api/repos/r1 + 刷新列表
    const pop2 = await openPopconfirm(wrapper, '删除')
    popAction(pop2, '确定').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    const calls = fetchMock.mock.calls
    const i = calls.findIndex(c => methodOf(c) === 'DELETE')
    expect(i).toBeGreaterThan(-1)
    expect(urlOf(calls[i])).toBe('/api/repos/r1')
    expect(calls.slice(i + 1).some(c => urlOf(c) === '/api/repos')).toBe(true)
    wrapper.unmount()   // teleport popper 随卸载清理
  })

  it('POST 409 → 错误横幅显示服务端冲突文案', async () => {
    const { wrapper } = await mountView({ postResult: { ok: false, json: { code: 'repo_exists' } } })
    await wrapper.find('input[placeholder="repo-id"]').setValue('r1')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const banner = wrapper.find('.el-alert--error')
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
    expect(wrapper.find('.el-alert--error').text()).toContain('id 仅允许字母数字与 . _ -')

    // 审查 C1：'..'/'.' 过白名单正则，但服务端 mirrorDir 会逃逸 → 前端同款先行拦截
    await id().setValue('..')
    await add()
    expect(wrapper.find('.el-alert--error').text()).toContain('id 不能为')

    await id().setValue('beta')
    await url().setValue('')
    await add()
    expect(wrapper.find('.el-alert--error').text()).toContain('url 不能为空')

    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'POST')).toBe(false)
  })

  it('编辑按钮进入行内编辑态：url 只读无输入框带提示；保存发 PATCH 三键载荷并刷新', async () => {
    const { wrapper, fetchMock } = await mountView()
    const editBtn = cellButton(wrapper, '编辑')
    expect(editBtn).toBeDefined()
    await editBtn!.trigger('click')

    // 编辑控件出现；url 保持只读文本（编辑态不加输入框）并带不可修改 title 提示
    expect(wrapper.find('tbody .edit-branch').exists()).toBe(true)
    expect(wrapper.find('tbody .edit-interval').exists()).toBe(true)
    expect(wrapper.find('tbody .edit-exclude').exists()).toBe(true)
    const urlCell = wrapper.find('td.url-cell')
    expect(urlCell.find('input').exists()).toBe(false)
    expect(urlCell.find('span').attributes('title')).toContain('url 不可修改')

    // 预填为当前行值
    expect((wrapper.find('tbody .edit-branch input').element as HTMLInputElement).value).toBe('main')
    expect((wrapper.find('tbody .edit-interval input').element as HTMLInputElement).value).toBe('30')

    await wrapper.find('tbody .edit-branch input').setValue('develop')
    await wrapper.find('tbody .edit-interval input').setValue('7')
    await wrapper.find('tbody .edit-exclude input').setValue('tmp/**, dist/**')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()

    const calls = fetchMock.mock.calls
    const i = calls.findIndex(c => methodOf(c) === 'PATCH')
    expect(i).toBeGreaterThan(-1)
    expect(urlOf(calls[i])).toBe('/api/repos/r1')
    // 载荷白名单（无 url/id）；排除 glob 逗号拆分为字符串数组；
    // v1.3.2 传输两键恒带 boolean/按三分支——默认行无传输配置 → bypassGitConfig:false、
    // 编辑态下拉预填 system → PATCH 显式 httpProxy:null（JSON Merge Patch unset，服务端
    // 对已无该字段的仓 delete 为无操作，幂等；省键承载不了"还原跟随系统"语义故不再省）；
    // v1.5 gitConfigPath 同构：默认行为空 → PATCH 显式 null（省键=服务端不改动，清不掉存量路径）
    expect(JSON.parse(String((calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 7, defaultBranch: 'develop', branchExclude: ['tmp/**', 'dist/**'],
      bypassGitConfig: false, httpProxy: null, gitConfigPath: null
    })
    // 保存成功 → 退出编辑态 + 刷新列表（PATCH 之后再次 GET /api/repos）
    expect(wrapper.find('tbody .edit-branch').exists()).toBe(false)
    expect(calls.slice(i + 1).some(c => urlOf(c) === '/api/repos')).toBe(true)
  })

  it('PATCH 400 → 错误横幅透出服务端 message 且留在编辑态；取消退出且不发请求', async () => {
    const { wrapper, fetchMock } = await mountView({
      patchResult: { ok: false, json: { code: 'invalid', message: 'pollIntervalSeconds: 需为 ≥5 的整数' } }
    })
    await cellButton(wrapper, '编辑')!.trigger('click')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()

    const banner = wrapper.find('.el-alert--error')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('pollIntervalSeconds: 需为 ≥5 的整数')   // message 优先 code 兜底
    expect(wrapper.find('tbody .edit-branch').exists()).toBe(true)   // 失败留在编辑态，可改后重试
    expect(fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')).toHaveLength(1)

    await cellButton(wrapper, '取消')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('tbody .edit-branch').exists()).toBe(false)  // 取消退出编辑态
    expect(wrapper.find('.el-alert--error').exists()).toBe(false)   // 顺带清掉横幅
    // 取消不触发任何请求：PATCH 仍只有此前失败的 1 次
    expect(fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')).toHaveLength(1)
  })

  it('前端先行校验：间隔非 ≥5 整数 / 分支为空拦在本地，不发出 PATCH', async () => {
    const { wrapper, fetchMock } = await mountView()
    await cellButton(wrapper, '编辑')!.trigger('click')
    const save = async (): Promise<void> => {
      await cellButton(wrapper, '保存')!.trigger('click')
      await flushPromises()
    }

    await wrapper.find('tbody .edit-interval input').setValue('0')
    await save()
    expect(wrapper.find('.el-alert--error').text()).toContain('轮询间隔须为不小于 5 的整数秒')

    await wrapper.find('tbody .edit-interval input').setValue('7.5')
    await save()
    expect(wrapper.find('.el-alert--error').text()).toContain('轮询间隔须为不小于 5 的整数秒')

    await wrapper.find('tbody .edit-interval input').setValue('7')
    await wrapper.find('tbody .edit-branch input').setValue('  ')
    await save()
    expect(wrapper.find('.el-alert--error').text()).toContain('默认分支不能为空')

    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)
  })

  it('前端先行校验：间隔超上限 604801 拦在本地不发 PATCH；下界 5 合法放行', async () => {
    const { wrapper, fetchMock } = await mountView()
    await cellButton(wrapper, '编辑')!.trigger('click')
    const save = async (): Promise<void> => {
      await cellButton(wrapper, '保存')!.trigger('click')
      await flushPromises()
    }

    // 超上界（604800 = 7 天）本地拦截，横幅文案含 604800，零 PATCH 发出
    await wrapper.find('tbody .edit-interval input').setValue('604801')
    await save()
    expect(wrapper.find('.el-alert--error').text()).toContain('604800')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)

    // 下界边界值 5 合法：本地不拦，PATCH 载荷按 5 发出
    await wrapper.find('tbody .edit-interval input').setValue('5')
    await save()
    expect(wrapper.find('.el-alert--error').exists()).toBe(false)
    const patchCall = fetchMock.mock.calls.find(c => methodOf(c) === 'PATCH')
    expect(patchCall).toBeDefined()
    expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toMatchObject({ pollIntervalSeconds: 5 })
  })

  it('行内编辑输入 Enter 保存：三个编辑输入 keyup.enter 均触发 onSave 发 PATCH', async () => {
    // 覆盖三个可编辑输入（默认分支/轮询间隔/排除 glob）：Enter 与"保存"按钮走同一 onSave 路径
    for (const sel of ['tbody .edit-branch', 'tbody .edit-interval', 'tbody .edit-exclude']) {
      const { wrapper, fetchMock } = await mountView()
      await cellButton(wrapper, '编辑')!.trigger('click')
      await wrapper.find(`${sel} input`).trigger('keyup.enter')
      await flushPromises()

      const patch = fetchMock.mock.calls.find(c => methodOf(c) === 'PATCH')
      expect(patch).toBeDefined()   // RED：无 Enter 接线时不发 PATCH
      expect(urlOf(patch!)).toBe('/api/repos/r1')
      // 预填值合法 → PATCH 载荷即当前行值；成功后退出编辑态
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
        pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
        bypassGitConfig: false, httpProxy: null, gitConfigPath: null
      })
      expect(wrapper.find('tbody .edit-branch').exists()).toBe(false)
    }
  })

  it('网络连接方式：下拉默认跟随系统（is-selected）且三选项文案齐全（省键/无代理/自定义）', async () => {
    const { wrapper } = await mountView()
    const sel = wrapper.find('.add-proxy-mode')
    expect(sel.exists()).toBe(true)
    const items = wrapper.findAll('.add-proxy-mode .el-select-dropdown__item')
    expect(items.map(o => o.text())).toEqual([
      '跟随本机 git 配置', '不走代理（强制无代理）', '通过指定代理服务器连接'
    ])
    // 默认 system：首项 is-selected（探针：初始未展开也渲染选中态）
    expect(items[0].classes()).toContain('is-selected')
    expect(items[1].classes()).not.toContain('is-selected')
  })

  it('网络连接方式：勾选绕过系统 git 配置（默认跟随系统）→ POST bypassGitConfig:true 且 httpProxy 省键', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    await wrapper.find('.add-bypass input').setValue(true)
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
    await pickOption(wrapper, '.add-proxy-mode', '不走代理（强制无代理）')
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
    await pickOption(wrapper, '.add-proxy-mode', '通过指定代理服务器连接')
    expect(wrapper.find('.add-proxy').exists()).toBe(true)

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('.el-alert--error').text()).toContain('代理地址不能为空')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'POST')).toBe(false)

    await wrapper.find('.add-proxy input').setValue('http://p:9')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: false, httpProxy: 'http://p:9'
    })
  })

  it('表格传输列四态：bypass→直连、httpProxy 非空→代理、""→无代理、省键→—（不再合流）；gitConfigPath→档案角标', async () => {
    const { wrapper } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 },
        { id: 'r2', url: 'u2', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, bypassGitConfig: true },
        { id: 'r3', url: 'u3', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, httpProxy: 'http://p:1' },
        { id: 'r4', url: 'u4', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, bypassGitConfig: false, httpProxy: '' },
        { id: 'r5', url: 'u5', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, gitConfigPath: '/cfg' }
      ]
    })
    const cells = wrapper.findAll('tbody tr').map(row => row.find('.transport-cell').text())
    expect(cells[0]).toBe('—')            // GET 行省键（T1：undefined=跟随系统）→ —
    expect(cells[1]).toContain('直连')     // bypass → 直连
    expect(cells[2]).toContain('代理')     // 非空 → 代理
    expect(cells[3]).toContain('无代理')   // httpProxy ''=显式强制无代理（v1.4 四态，不再与 — 合流）
    expect(cells[4]).toContain('档案')     // v1.5：指定配置档案 → 角标（title 携带路径）
  })

  it('行内编辑网络连接方式：预填映射三态；保存 PATCH 三态载荷（自定义值/强制直连 ""/跟随系统 null 显式 unset）', async () => {
    const { wrapper, fetchMock } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, httpProxy: 'http://old:1' }
      ]
    })
    await cellButton(wrapper, '编辑')!.trigger('click')

    // 预填映射：httpProxy 非空 → custom 态（is-selected）+ 输入框回填原值；bypass 省键 → unchecked
    const selectedLabel = (): string => {
      const sel = wrapper.findAll('tbody .edit-proxy-mode .el-select-dropdown__item').find(i => i.classes().includes('is-selected'))
      return sel?.text() ?? ''
    }
    expect(selectedLabel()).toBe('指定代理')
    expect((wrapper.find('tbody .edit-proxy input').element as HTMLInputElement).value).toBe('http://old:1')
    expect((wrapper.find('tbody .edit-bypass input').element as HTMLInputElement).checked).toBe(false)

    // 第一轮：custom 态改值（未勾绕过）→ PATCH 带 bypassGitConfig:false + httpProxy 新值
    await wrapper.find('tbody .edit-proxy input').setValue('http://new:2')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()
    const i = fetchMock.mock.calls.findIndex(c => methodOf(c) === 'PATCH')
    expect(JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: 'http://new:2', gitConfigPath: null
    })

    // 第二轮：切"不走代理"（stub 静态回 http://old:1 → 重新预填 custom）→ PATCH httpProxy:''（bypass 独立保持 false）
    await cellButton(wrapper, '编辑')!.trigger('click')
    await pickOption(wrapper, 'tbody .edit-proxy-mode', '不走代理')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()
    const patchCalls = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls).toHaveLength(2)
    expect(JSON.parse(String((patchCalls[1][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: '', gitConfigPath: null
    })

    // 第三轮：切回"跟随本机配置" → PATCH 显式 httpProxy:null（JSON Merge Patch unset——
    // 修复三态编辑缺口：已设代理的仓可经 UI 还原为跟随系统；省键=服务端不改动，不能承载该语义）
    await cellButton(wrapper, '编辑')!.trigger('click')
    await pickOption(wrapper, 'tbody .edit-proxy-mode', '跟随本机配置')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()
    const patchCalls3 = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls3).toHaveLength(3)
    const body3 = JSON.parse(String((patchCalls3[2][1] as RequestInit).body))
    expect(body3).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: null, gitConfigPath: null
    })
    expect('httpProxy' in body3).toBe(true)   // 键显式在场且为 null——省键会被服务端理解为"不改动"
  })

  it('行内编辑：省键行预填跟随系统态；选通过代理服务器连接但地址为空 → 本地拦截不发 PATCH', async () => {
    const { wrapper, fetchMock } = await mountView()   // reposPayload r1 无 httpProxy 键
    await cellButton(wrapper, '编辑')!.trigger('click')

    // 预填映射：省键（undefined=跟随系统）→ system 态（is-selected）且不渲染代理输入框
    const selectedLabel = (): string => {
      const sel = wrapper.findAll('tbody .edit-proxy-mode .el-select-dropdown__item').find(i => i.classes().includes('is-selected'))
      return sel?.text() ?? ''
    }
    expect(selectedLabel()).toBe('跟随本机配置')
    expect(wrapper.find('tbody .edit-proxy').exists()).toBe(false)

    await pickOption(wrapper, 'tbody .edit-proxy-mode', '指定代理')
    expect(wrapper.find('tbody .edit-proxy').exists()).toBe(true)   // 仅 custom 态显现
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.el-alert--error').text()).toContain('代理地址不能为空')
    expect(fetchMock.mock.calls.some(c => methodOf(c) === 'PATCH')).toBe(false)
  })

  it('v1.5 添加表单：填自定义 git 配置文件 → POST 载荷带 gitConfigPath（trim 后）；填了路径则禁用直连 checkbox', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    const cfgInput = wrapper.find('.add-gitcfg')
    expect(cfgInput.exists()).toBe(true)
    await cfgInput.find('input').setValue('  /path/to/git-config  ')
    // 反向互斥：填了路径 → 直连 checkbox 禁用（服务端生效态 400 mutually_exclusive，前端先拦）
    expect((wrapper.find('.add-bypass input').element as HTMLInputElement).disabled).toBe(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    expect(call).toBeDefined()
    // POST 空输入省键（undefined，T1 语义），此处填了路径 → 键在场且 trim；httpProxy 跟随系统省键
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: false, gitConfigPath: '/path/to/git-config'
    })
  })

  it('v1.5 添加表单互斥联动：勾直连 → 清空并禁用 git 配置输入，POST 载荷不带 gitConfigPath 键', async () => {
    const { wrapper, fetchMock } = await mountView()
    await wrapper.find('input[placeholder="repo-id"]').setValue('beta')
    await wrapper.find('input[placeholder="https://example.com/beta.git"]').setValue('https://example.com/beta.git')
    const bypass = wrapper.find('.add-bypass input')
    expect((bypass.element as HTMLInputElement).disabled).toBe(false)   // 路径为空 → 直连可用
    await bypass.setValue(true)

    const cfgInput = wrapper.find('.add-gitcfg input')
    expect((cfgInput.element as HTMLInputElement).disabled).toBe(true)   // 勾直连 → 输入禁用
    expect((cfgInput.element as HTMLInputElement).value).toBe('')        // 且被清空
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const call = fetchMock.mock.calls.find(c => methodOf(c) === 'POST')
    // 空输入 POST 省键（undefined 省键语义）：载荷精确无 gitConfigPath
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      id: 'beta', url: 'https://example.com/beta.git', bypassGitConfig: true
    })
  })

  it('v1.5 行内编辑 git 配置文件：预填回显/换路径 PATCH 回显；勾直连先清路径 → PATCH 带 bypassGitConfig:true + gitConfigPath:null', async () => {
    const { wrapper, fetchMock } = await mountView({
      reposList: [
        { id: 'r1', url: 'u1', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30, gitConfigPath: '/cfg/a' }
      ]
    })
    await cellButton(wrapper, '编辑')!.trigger('click')
    const cfgInput = wrapper.find('tbody .edit-gitcfg')
    expect(cfgInput.exists()).toBe(true)
    expect((cfgInput.find('input').element as HTMLInputElement).value).toBe('/cfg/a')                     // startEdit 预填
    expect((wrapper.find('tbody .edit-bypass input').element as HTMLInputElement).disabled).toBe(true)  // 反向互斥

    // 第一轮：换另一路径 → PATCH 回显新路径（trim）
    await cfgInput.find('input').setValue('/cfg/b')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()
    const patchCalls = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls).toHaveLength(1)
    expect(JSON.parse(String((patchCalls[0][1] as RequestInit).body))).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: false, httpProxy: null, gitConfigPath: '/cfg/b'
    })

    // 第二轮：清空路径 → 直连解禁 → 勾直连（联动清空+禁用输入）→ 单次保存完成切换。
    // PATCH 显式 gitConfigPath:null：省键会被服务端按"不改动"解释——存量路径原样保留，
    // 与 bypassGitConfig:true 撞生效态互斥 400，单次保存切换必须显式 null（JSON Merge Patch unset）
    await cellButton(wrapper, '编辑')!.trigger('click')
    await wrapper.find('tbody .edit-gitcfg input').setValue('')
    expect((wrapper.find('tbody .edit-bypass input').element as HTMLInputElement).disabled).toBe(false)
    await wrapper.find('tbody .edit-bypass input').setValue(true)
    expect((wrapper.find('tbody .edit-gitcfg input').element as HTMLInputElement).disabled).toBe(true)
    expect((wrapper.find('tbody .edit-gitcfg input').element as HTMLInputElement).value).toBe('')
    await cellButton(wrapper, '保存')!.trigger('click')
    await flushPromises()
    const patchCalls2 = fetchMock.mock.calls.filter(c => methodOf(c) === 'PATCH')
    expect(patchCalls2).toHaveLength(2)
    const body2 = JSON.parse(String((patchCalls2[1][1] as RequestInit).body))
    expect(body2).toEqual({
      pollIntervalSeconds: 30, defaultBranch: 'main', branchExclude: [],
      bypassGitConfig: true, httpProxy: null, gitConfigPath: null
    })
    expect('gitConfigPath' in body2).toBe(true)   // 键显式在场且为 null——省键承载不了"清除"
  })
})
