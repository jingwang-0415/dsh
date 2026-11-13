import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Compare from '../src/views/Compare.vue'

// v1.6 最终修复波（Fix 3）：Compare 首个挂载冒烟——此前该视图零测试裸奔。
// 冒烟断言三件事：方向统计 el-tag 文本 / 双列独有列表行数 / commit 行 RouterLink
// 对象式 :to 的 href 全等（编码回归锁：repo id 含 & 时串拼接会把查询串劈成两段，
// CrossRepo.test.ts「对象式 :to」先例同款断言形态）。
// EP 陷阱复用既有探针结论（勿再踩坑）：stubs.transition=false 防 el-tag 根被吞；
// jsdom 无 ResizeObserver → stub；/commit/:sha 需空壳注册否则 href 解析刷 stderr 噪音。

const reposPayload = [{ id: 'a&b', url: 'u', defaultBranch: 'main', branchExclude: [], pollIntervalSeconds: 30 }]
const branchesPayload = [
  { name: 'main', status: 'active', headSha: null, lastSubject: null, lastAuthor: null, lastCommitAt: null, behindDefault: 0, rewritten: false, recentCommits: 0 },
  { name: 'dev', status: 'active', headSha: null, lastSubject: null, lastAuthor: null, lastCommitAt: null, behindDefault: 0, rewritten: false, recentCommits: 0 },
  { name: 'gone', status: 'gone', headSha: null, lastSubject: null, lastAuthor: null, lastCommitAt: null, behindDefault: 0, rewritten: false, recentCommits: 0 }
]
const shaA1 = 'a'.repeat(40)
const shaA2 = 'c'.repeat(40)
const shaB1 = 'b'.repeat(40)
const comparePayload = {
  ahead: 2,
  behind: 1,
  aheadCommits: [
    { sha: shaA1, authorName: 'alice', authorEmail: '', committedAt: 1, subject: 'main 独有其一', body: '', firstSeenBranch: null },
    { sha: shaA2, authorName: 'bob', authorEmail: '', committedAt: 2, subject: 'main 独有其二', body: '', firstSeenBranch: null }
  ],
  behindCommits: [
    { sha: shaB1, authorName: 'carol', authorEmail: '', committedAt: 3, subject: 'dev 独有其一', body: '', firstSeenBranch: null }
  ]
}

const RO_STUB = class { observe(): void {} unobserve(): void {} disconnect(): void {} }

async function mountView(): Promise<{
  wrapper: VueWrapper
  fetchMock: ReturnType<typeof vi.fn>
  router: Router
}> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url === '/api/repos') return reposPayload
      if (url.startsWith('/api/branches')) return branchesPayload
      if (url.startsWith('/api/compare')) return comparePayload
      return {}
    }
  }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', RO_STUB)
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/compare', component: Compare },
      { path: '/commit/:sha', component: { template: '<div />' } }
    ]
  })
  await router.push('/compare')
  await router.isReady()
  const wrapper: VueWrapper = mount(Compare, { global: { plugins: [router], stubs: { transition: false } } })
  await flushPromises()
  return { wrapper, fetchMock, router }
}

describe('Compare 视图挂载冒烟（v1.6 最终修复波）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.querySelectorAll('.el-popper').forEach(n => n.remove())   // 弹层不跨用例串扰
  })

  it('加载链走通（repos→branches→compare）且方向统计 el-tag 文本正确', async () => {
    const { wrapper, fetchMock } = await mountView()
    // 缺省语义：首仓 + active 分支前两位（gone 不入下拉）
    const urls = fetchMock.mock.calls.map(c => String(c[0]))
    expect(urls).toContain('/api/repos')
    expect(urls).toContain('/api/branches?repo=a%26b')
    expect(urls).toContain('/api/compare?base=main&target=dev&repo=a%26b')

    // 方向统计：ahead=2 → success el-tag；behind=1 → warning el-tag（业务文案逐字保留）
    expect(wrapper.find('.dir-line .el-tag--success').text()).toBe('2')
    expect(wrapper.find('.dir-line .el-tag--warning').text()).toBe('1')
    expect(wrapper.find('.dir-line').text()).toContain('个提交，落后')
  })

  it('双列独有列表行数与表头计数正确', async () => {
    const { wrapper } = await mountView()
    const cols = wrapper.findAll('.el-col')
    expect(cols).toHaveLength(2)
    expect(cols[0].find('h3').text()).toBe('main 独有（2）')
    expect(cols[0].findAll('.rows .row')).toHaveLength(2)
    expect(cols[1].find('h3').text()).toBe('dev 独有（1）')
    expect(cols[1].findAll('.rows .row')).toHaveLength(1)

    // 行内容：sha 前 10 位 code + subject + 作者
    const first = cols[0].findAll('.rows .row')[0]
    expect(first.find('code').text()).toBe(shaA1.slice(0, 10))
    expect(first.text()).toContain('main 独有其一')
    expect(first.text()).toContain('alice')
  })

  it('commit 行 RouterLink 对象式 :to：href 全等（repo id 含 & 统一编码 a%26b）', async () => {
    // 串拼接 bug 类（CrossRepo 先例）：?repo=a&b 会被 router 劈成 { repo:'a', b:'' }，
    // href 退化为 ?repo=a&b=；对象式 :to 编码为 ?repo=a%26b——修复前此断言必 RED
    const { wrapper } = await mountView()
    const links = wrapper.findAll('a').filter(l => (l.attributes('href') ?? '').startsWith('/commit/'))
    expect(links.map(l => l.attributes('href') ?? '')).toEqual([
      `/commit/${shaA1}?repo=a%26b`,
      `/commit/${shaA2}?repo=a%26b`,
      `/commit/${shaB1}?repo=a%26b`
    ])
  })
})
