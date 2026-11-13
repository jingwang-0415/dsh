import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CrossRepo from '../src/views/CrossRepo.vue'

// v1.6-T3 Element Plus 迁移：DOM 定位适配 EP 结构（四枚 el-select / el-input 路径过滤 /
// el-alert 错误横幅 / el-row·el-col 统计与双列），业务断言逐字保留（对比请求 URL 与路径过滤 /
// 未配对禁选 / 对象式 :to href 精确编码 / 切仓派生分支与空参形态消除）。
// EP 陷阱复用 T2 探针结论（勿再踩坑）：
// - VTU 默认 stub transition 会吞 el-alert/el-tag 根节点 → mount 统一 stubs.transition=false
// - 四枚下拉均不在表格 cell 内 → :teleported="false"（弹层随组件渲染，可作用域查询；
//   未展开亦可直接点击选项完成选择——Repos/Overview 同款探针结论）
// - 原生 <select>.setValue 定位迁 pickOption（作用域 .el-select-dropdown__item 文本点击）

const reposPayload = [
  { id: 'gh', url: 'https://github.com/x/dsh', defaultBranch: 'main', pollIntervalSeconds: 10 },
  { id: 'gte', url: 'git@gitee.com:x/dsh2', defaultBranch: 'main', pollIntervalSeconds: 10 }
]
const branchesPayload = {
  repoA: { id: 'gh', branches: ['main', 'feat'] },
  repoB: { id: 'gte', branches: ['main'] },
  paired: ['main'], unpairedA: ['feat'], unpairedB: []
}
const comparePayload = {
  branchPair: { repoA: 'gh', branchA: 'main', repoB: 'gte', branchB: 'main' },
  onlyInA: [{ sha: 'a'.repeat(40), authorName: 'A', authorEmail: '', committedAt: 1, subject: 'github 独有改动', body: '', firstSeenBranch: null }],
  onlyInB: [{ sha: 'b'.repeat(40), authorName: 'B', authorEmail: '', committedAt: 2, subject: 'gitee 独有改动', body: '', firstSeenBranch: null }],
  matchedPairs: [{ patchId: 'p1', shaA: 'c'.repeat(40), shaB: 'd'.repeat(40), subjectA: '同补丁改动' }],
  unpairedBranches: { repoA: ['feat'], repoB: [] },
  stats: { aTotal: 3, bTotal: 2, matched: 1, onlyA: 1, onlyB: 1 }
}

// 简报原为 params: Record<string, string>，实际调用传入 query 字符串——按严格模式最小修正为 string（断言语义不变）
function routeTo(_query: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.startsWith('/api/crossrepo/compare')) return comparePayload
      if (url.startsWith('/api/crossrepo/branches')) return branchesPayload
      if (url === '/api/repos') return reposPayload
      return []
    }
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function mountView(query: string) {
  const fetchMock = await routeTo(query)
  // /commit/:sha 以空壳注册：onlyIn 行 RouterLink 解析 href 需要目标路由在场，
  // 否则 vue-router 每次渲染都刷 "No match found" stderr 噪音（Overview.test.ts 同款 stub 路由模式）
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/crossrepo', component: CrossRepo },
      { path: '/commit/:sha', component: { template: '<div />' } }
    ]
  })
  await router.push(`/crossrepo${query}`)
  await router.isReady()
  const wrapper: VueWrapper = mount(CrossRepo, { global: { plugins: [router], stubs: { transition: false } } })
  await flushPromises()
  return { wrapper, fetchMock, router }
}

// el-select 选项点击：下拉 teleported=false → 选项渲染在组件根内按 select 类作用域查询
// （探针：未展开亦可直接点击完成选择并触发 change；Repos.test.ts pickOption 同款两段式，
// 保留 document 弹层回退以定位走错路径时给出说明性报错）
async function pickOption(wrapper: VueWrapper, sel: string, label: string): Promise<void> {
  const scopedItem = wrapper
    .findAll(`${sel} .el-select-dropdown__item`)
    .find(i => i.text() === label)
  if (scopedItem) {
    await scopedItem.trigger('click')
    await flushPromises()
    return
  }
  const item = Array.from(document.querySelectorAll<HTMLElement>('.el-select__popper .el-select-dropdown__item'))
    .find(i => i.textContent?.trim() === label)
  expect(item, `下拉选项「${label}」应存在于 ${sel}（作用域或 body 弹层）`).not.toBeNull()
  item!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

// 当前选中项文案（teleported=false 下拉静态渲染 is-selected，Repos.test.ts 同款探针结论）
const selectedLabel = (wrapper: VueWrapper, sel: string): string =>
  wrapper.find(`${sel} .el-select-dropdown__item.is-selected`).text()

describe('CrossRepo 视图', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    document.querySelectorAll('.el-popper').forEach(n => n.remove())   // 弹层不跨用例串扰
  })

  it('matched 灰色并排展示 shaA↔shaB，单向独有分区正确', async () => {
    const { wrapper } = await mountView('')
    const html = wrapper.html()
    expect(html).toContain('源码一致（同补丁）')
    expect(html).toContain('github 独有改动')
    expect(html).toContain('gitee 独有改动')
    expect(wrapper.findAll('.row-matched')).toHaveLength(1)
    expect(wrapper.text()).toContain('c'.repeat(12))
    expect(wrapper.text()).toContain('d'.repeat(12))
  })

  it('对比请求携带路径过滤与分支参数', async () => {
    const { fetchMock } = await mountView('?repoA=gh&repoB=gte&branchA=main&branchB=main&exclude=vendor%2F**')
    const called = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.find((u: unknown[]) => String(u[0]).includes('/api/crossrepo/compare'))
    const url = String(called![0])
    expect(url).toContain('repoA=gh')
    expect(url).toContain('repoB=gte')
    expect(url).toContain('branchA=main')
    expect(url).toContain('branchB=main')
    expect(url).toContain('exclude=vendor%2F**')
  })

  it('onlyIn 行 RouterLink 对象式 :to：query 值经 vue-router 统一编码，href 精确匹配', async () => {
    // 串拼接的 bug 类：repo id 含 & 会把查询串劈成两个参数（?repo=a&b → repo=a + b）；
    // 对象式 :to 由 vue-router 统一编码（a%26b），此处以 href 全等断言锁定（消 toContain 子串弱点）
    const { wrapper } = await mountView(`?repoA=${encodeURIComponent('a&b')}&repoB=gte`)
    const links = wrapper.findAll('a').filter(l => (l.attributes('href') ?? '').startsWith('/commit/'))
    expect(links).toHaveLength(2)   // onlyInA / onlyInB 各一条

    expect(links[0].attributes('href')).toBe(`/commit/${'a'.repeat(40)}?repo=a%26b`)   // onlyInA 行带 repoA 归属
    expect(links[1].attributes('href')).toBe(`/commit/${'b'.repeat(40)}?repo=gte`)     // onlyInB 行带 repoB 归属
  })

  it('未配对分支在下拉中标注（未配对）且 el-option disabled 禁选；配对侧可选', async () => {
    const { wrapper } = await mountView('?repoA=gh&repoB=gte&branchA=main&branchB=main')
    // A 侧：feat 不在 B 分支列表 → 标注（未配对）且禁选；main 配对可选
    const itemsA = wrapper.findAll('.select-branch-a .el-select-dropdown__item')
    expect(itemsA.map(i => i.text())).toEqual(['main', 'feat（未配对）'])
    const feat = itemsA.find(i => i.text() === 'feat（未配对）')!
    expect(feat.classes()).toContain('is-disabled')
    expect(itemsA.find(i => i.text() === 'main')!.classes()).not.toContain('is-disabled')
    // B 侧：全部配对 → 无未配对项
    expect(wrapper.findAll('.select-branch-b .el-select-dropdown__item').map(i => i.text())).toEqual(['main'])
  })

  it('切仓后 URL 回写新默认分支（paired[0]），消除 branchA=&branchB= 空参形态', async () => {
    const { wrapper, router } = await mountView('?repoA=gh&repoB=gte&branchA=feat&branchB=main')
    expect(selectedLabel(wrapper, '.select-repo-a')).toBe('gh')
    await pickOption(wrapper, '.select-repo-a', 'gte')   // 切仓 A → onRepoChange
    await flushPromises()
    expect(router.currentRoute.value.query.branchA).toBe('main')
    expect(router.currentRoute.value.query.branchB).toBe('main')
    expect(router.currentRoute.value.fullPath).not.toContain('branchA=&branchB=')
  })

  it('切仓且 branches 请求失败时 URL 不落空分支键（无 branchA=/branchB= 键）', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !url.startsWith('/api/crossrepo/branches'),   // branches 端点恒失败
      json: async () => {
        if (url.startsWith('/api/crossrepo/compare')) return comparePayload
        if (url === '/api/repos') return reposPayload
        return []
      }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/crossrepo', component: CrossRepo },
        { path: '/commit/:sha', component: { template: '<div />' } }
      ]
    })
    await router.push('/crossrepo?repoA=gh&repoB=gte&branchA=feat&branchB=main')
    await router.isReady()
    const wrapper: VueWrapper = mount(CrossRepo, { global: { plugins: [router], stubs: { transition: false } } })
    await flushPromises()
    await pickOption(wrapper, '.select-repo-a', 'gte')   // 切仓 A，branches 派生失败
    await flushPromises()
    const banner = wrapper.find('.el-alert--error')
    expect(banner.exists()).toBe(true)   // 失败路径真实发生（el-alert error 横幅）
    expect(banner.text()).not.toBe('')
    expect(router.currentRoute.value.fullPath).not.toContain('branchA=')
    expect(router.currentRoute.value.fullPath).not.toContain('branchB=')
  })
})
