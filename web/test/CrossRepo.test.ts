import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CrossRepo from '../src/views/CrossRepo.vue'

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
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/crossrepo', component: CrossRepo }] })
  await router.push(`/crossrepo${query}`)
  await router.isReady()
  const wrapper = mount(CrossRepo, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, fetchMock, router }
}

describe('CrossRepo 视图', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

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

  it('切仓后 URL 回写新默认分支（paired[0]），消除 branchA=&branchB= 空参形态', async () => {
    const { wrapper, router } = await mountView('?repoA=gh&repoB=gte&branchA=feat&branchB=main')
    const selects = wrapper.findAll('select')
    expect(selects[0].element.value).toBe('gh')
    await selects[0].setValue('gte')   // 切仓 A → onRepoChange
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
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/crossrepo', component: CrossRepo }] })
    await router.push('/crossrepo?repoA=gh&repoB=gte&branchA=feat&branchB=main')
    await router.isReady()
    const wrapper = mount(CrossRepo, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.findAll('select')[0].setValue('gte')   // 切仓 A，branches 派生失败
    await flushPromises()
    expect(wrapper.find('.banner-red').exists()).toBe(true)   // 失败路径真实发生
    expect(router.currentRoute.value.fullPath).not.toContain('branchA=')
    expect(router.currentRoute.value.fullPath).not.toContain('branchB=')
  })
})
