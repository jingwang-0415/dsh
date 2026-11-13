import { flushPromises, mount } from '@vue/test-utils'
import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'
import Overview from '../src/views/Overview.vue'

// v1.6-T2 Element Plus 迁移：定位适配 EP 结构（el-alert/el-select/el-table/el-tag/el-badge/ElMessage），
// 业务断言逐字保留（POST/PATCH 载荷键值/URL/状态四分支/三分支语义/切仓守卫）。
// 探针实证（zz-probe，临时文件不提交）：
// - VTU 默认 stub transition 会吞掉 el-alert/el-tag 根节点 → mount 统一 stubs.transition=false
// - el-table mounted 依赖 ResizeObserver（jsdom 无）→ mountView 内 stubGlobal
// - el-select :teleported="false" → 选项渲染在组件根内可作用域查询，未展开亦可直接点击选项完成选择
// - ElMessage 落 document.body（.el-message--success/-info/-error），用后 closeAll + 节点清理防跨用例串扰

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
  statusOverride?: Record<string, unknown>
  reposList?: { id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number }[]
  branchesList?: unknown[]
  statusFails?: boolean
}

function stubFetch(opts: FetchOpts = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const r = opts.syncResult ?? { ok: true, json: { ok: true, newCommits: 2 } }
      return { ok: r.ok, json: async () => r.json }
    }
    if (url.startsWith('/api/status')) {
      if (opts.statusFails) throw new Error('status boom')
      return { ok: true, json: async () => opts.statusOverride ?? statusPayload }
    }
    if (url.startsWith('/api/branches')) return { ok: true, json: async () => opts.branchesList ?? [] }
    if (url === '/api/repos') return { ok: true, json: async () => opts.reposList ?? reposPayload }
    return { ok: true, json: async () => ({}) }
  })
}

const RO_STUB = class { observe(): void {} unobserve(): void {} disconnect(): void {} }

async function mountView(opts: FetchOpts = {}, fetchMock?: ReturnType<typeof vi.fn>) {
  const fm = fetchMock ?? stubFetch(opts)
  vi.stubGlobal('fetch', fm)
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  vi.stubGlobal('ResizeObserver', RO_STUB)
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Overview },
      { path: '/compare', component: { template: '<div />' } },
      { path: '/repos', component: { template: '<div />' } }
    ]
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(Overview, { global: { plugins: [router], stubs: { transition: false } } })
  await flushPromises()
  return { wrapper, fetchMock: fm, router }
}

const syncButton = (wrapper: VueWrapper): DOMWrapper<Element> =>
  wrapper.findAll('button').find(b => b.text() === '立即同步')!

// ElMessage 落 document.body（VTU wrapper 之外）
const messageNodes = (): HTMLElement[] => Array.from(document.querySelectorAll('.el-message'))

// 切仓：el-select（teleported=false）作用域内按文本点选项（探针：未展开亦可直接选中并触发 change）
async function selectRepo(wrapper: VueWrapper, id: string): Promise<void> {
  const item = wrapper
    .findAll('.repo-select .el-select-dropdown__item')
    .find(i => i.text() === id)
  expect(item, `下拉选项 ${id} 应存在`).toBeDefined()
  await item!.trigger('click')
  await flushPromises()
}

describe('Overview 手动同步按钮（v1.3.2，EP 迁移适配）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // 瞬时消息不跨用例串扰
    ElMessage.closeAll()
    document.querySelectorAll('.el-message').forEach(n => n.remove())
    document.querySelectorAll('.el-popper').forEach(n => n.remove())
  })

  it('点击立即同步 → POST /api/repos/r1/sync（当前选中仓）；检出 2 → success 消息 + 完成后 refresh + 按钮恢复', async () => {
    const { wrapper, fetchMock } = await mountView()
    const btn = syncButton(wrapper)
    expect(btn).toBeDefined()   // RED：按钮不存在
    await btn.trigger('click')
    await flushPromises()

    const i = fetchMock.mock.calls.findIndex(c => ((c[1] as RequestInit | undefined)?.method) === 'POST')
    expect(i).toBeGreaterThan(-1)
    expect(fetchMock.mock.calls[i][0]).toBe('/api/repos/r1/sync')

    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--success')).toBe(true)
    expect(msgs[0].textContent).toContain('手动同步完成：检出 2 个新提交')
    // 完成后 refresh：POST 之后再次 GET /api/repos
    expect(fetchMock.mock.calls.slice(i + 1).some(c => c[0] === '/api/repos')).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()   // 完成后恢复可点
  })

  it('请求期间按钮 disabled（防连点）；skipped → info"已有同步在进行中"', async () => {
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
    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--info')).toBe(true)
    expect(msgs[0].textContent).toContain('已有同步在进行中')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('ok:false → error"同步失败：<error>"', async () => {
    const { wrapper } = await mountView({ syncResult: { ok: true, json: { ok: false, error: 'fetch boom' } } })
    await syncButton(wrapper).trigger('click')
    await flushPromises()
    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--error')).toBe(true)
    expect(msgs[0].textContent).toContain('同步失败：fetch boom')
  })

  it('sendJson 通道抛错（fetch reject）→ error"同步失败：<message>"', async () => {
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
    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--error')).toBe(true)
    expect(msgs[0].textContent).toContain('同步失败：network boom')
  })

  it('newCommits=0 → info"手动同步完成：无新提交"', async () => {
    const { wrapper } = await mountView({ syncResult: { ok: true, json: { ok: true, newCommits: 0 } } })
    await syncButton(wrapper).trigger('click')
    await flushPromises()
    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--info')).toBe(true)
    expect(msgs[0].textContent).toContain('手动同步完成：无新提交')
  })

  it('在飞切仓：旧仓迟到结果不落新仓语境（守卫不回写，无"检出 5"消息）', async () => {
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

    // 第一轮：正常完成 → success 消息落笔（旧仓语境的既有结果）
    await btn.trigger('click')
    await flushPromises()
    expect(messageNodes().some(m => m.textContent?.includes('手动同步完成：检出 2 个新提交'))).toBe(true)

    // 第二轮：在飞（POST 挂起）→ 切仓（el-select 触发 onRepoChange：回写 query + refresh）
    const click = btn.trigger('click')
    await flushPromises()
    await selectRepo(wrapper, 'r2')
    await flushPromises()

    // 旧仓结果迟到落地：守卫拦截，"检出 5"消息不得出现在新仓语境
    release()
    await click
    await flushPromises()
    expect(messageNodes().some(m => m.textContent?.includes('检出 5'))).toBe(false)
    expect(btn.attributes('disabled')).toBeUndefined()        // finally 仍收敛 syncing
    const posts = fetchMock.mock.calls.filter(c => ((c[1] as RequestInit | undefined)?.method) === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts.every(c => c[0] === '/api/repos/r1/sync')).toBe(true)   // 两次都发往旧仓（发起时捕获）
  })
})

describe('Overview 状态条与分支表（EP 迁移适配）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    ElMessage.closeAll()
    document.querySelectorAll('.el-message').forEach(n => n.remove())
    document.querySelectorAll('.el-popper').forEach(n => n.remove())
  })

  it('状态条四分支 → el-alert type 映射：正常=success / 重试中=warning / 上轮失败=error / 连接中=info，且不可关闭', async () => {
    // 分支①：consecutiveFailures > 0 → warning（文案保留原文）
    const warn = await mountView({ statusOverride: { ...statusPayload, consecutiveFailures: 2 } })
    const warnAlert = warn.wrapper.find('.el-alert')
    expect(warnAlert.classes()).toContain('el-alert--warning')
    expect(warnAlert.text()).toContain('监听重试中（第 2 次失败）')
    expect(warnAlert.text()).toContain('下次重试')

    // 分支②：lastFetch.status === 'failed' → error（文案分支不变：监听正常 · 上次同步）
    const err = await mountView({
      statusOverride: { ...statusPayload, lastFetch: { status: 'failed', started_at: 0, finished_at: 1, error: 'x' } }
    })
    expect(err.wrapper.find('.el-alert').classes()).toContain('el-alert--error')
    expect(err.wrapper.find('.el-alert').text()).toContain('监听正常 · 上次同步')

    // 分支③：正常 → success
    const ok = await mountView()
    expect(ok.wrapper.find('.el-alert').classes()).toContain('el-alert--success')
    expect(ok.wrapper.find('.el-alert').text()).toContain('监听正常 · 上次同步')

    // 分支④：初始加载失败（status 恒 null）→ info"连接中…"；同时 error 横幅透出加载失败
    const connecting = await mountView({ statusFails: true })
    const infoAlert = connecting.wrapper.find('.el-alert--info')
    expect(infoAlert.exists()).toBe(true)
    expect(infoAlert.text()).toContain('连接中…')
    expect(connecting.wrapper.find('.el-alert--error').text()).toContain('加载失败')

    // 状态条不可关闭（CLOSABLE=false 语义）
    expect(ok.wrapper.find('.el-alert__closebtn').exists()).toBe(false)
  })

  it('分支表 el-table：行内容/徽标 el-tag（默认/历史重写/新提交）+ 落后 el-badge 点击路由跳转对比页', async () => {
    const branches = [
      { name: 'main', status: 'active', headSha: null, lastSubject: 'feat: x', lastAuthor: 'alice', lastCommitAt: 1700000000000, behindDefault: 2, rewritten: false, recentCommits: 3 },
      { name: 'dev', status: 'active', headSha: null, lastSubject: null, lastAuthor: null, lastCommitAt: null, behindDefault: 0, rewritten: true, recentCommits: 0 }
    ]
    const { wrapper, router } = await mountView({ branchesList: branches })
    const rows = wrapper.findAll('tbody tr')
    expect(rows.length).toBe(2)

    // 第一行：main 为默认分支 → 默认徽标；落后 2 → el-badge 徽标值；新提交 3 → danger el-tag
    const r1 = rows[0]
    expect(r1.text()).toContain('main')
    expect(r1.text()).toContain('默认')
    expect(r1.text()).toContain('feat: x')
    expect(r1.text()).toContain('alice')
    expect(r1.find('.el-badge__content').text()).toBe('2')
    const tag = r1.findAll('.el-tag').find(t => t.text() === '3')
    expect(tag).toBeDefined()
    expect(tag!.classes()).toContain('el-tag--danger')

    // 第二行：dev 历史重写徽标；落后 0 → 非徽标（muted 0）；无新提交 → 非 danger 徽标
    const r2 = rows[1]
    expect(r2.text()).toContain('历史重写')
    expect(r2.find('.el-badge__content').exists()).toBe(false)
    expect(r2.findAll('.el-tag--danger').length).toBe(0)

    // 落后徽标点击 → 保留路由跳转语义（/compare + repo/base/target 查询）
    await r1.find('.el-badge .el-link').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/compare')
    expect(router.currentRoute.value.query).toMatchObject({ repo: 'r1', base: 'main', target: 'main' })
  })
})
