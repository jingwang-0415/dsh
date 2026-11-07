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
  return { wrapper, fetchMock }
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
    expect(String(called![0])).toContain('exclude=vendor%2F**')
  })
})
