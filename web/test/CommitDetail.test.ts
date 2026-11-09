import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CommitDetail from '../src/views/CommitDetail.vue'

const sha = 'a'.repeat(40)
const payload = {
  commit: { sha, authorName: 'Alice', authorEmail: 'a@x', committedAt: 1, subject: 'fix: 严重崩溃', body: '', firstSeenBranch: 'master' },
  // 故意乱序传入，验证组件按「未包含→已包含→灰显」分区渲染
  results: [
    { branch: 'release/2.0', contains: true, status: 'active' },
    { branch: 'release/1.0', contains: false, status: 'active' },
    { branch: 'master', contains: true, status: 'active' },
    { branch: 'tmp/x', contains: false, status: 'deleted' }
  ]
}

async function mountView(query = '') {
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => payload }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/commit/:sha', component: CommitDetail }]
  })
  await router.push(`/commit/${sha}${query}`)
  await router.isReady()
  const wrapper = mount(CommitDetail, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('CommitDetail 视图', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('未包含红色置顶，已包含其后，删除分支灰显', async () => {
    const { wrapper } = await mountView()
    const html = wrapper.html()
    const missIdx = html.indexOf('release/1.0')
    const okIdx = html.indexOf('release/2.0')
    const otherIdx = html.indexOf('tmp/x')
    expect(missIdx).toBeGreaterThan(-1)
    expect(missIdx).toBeLessThan(okIdx)           // 未包含在已包含之前
    // 行内含复制按钮文案，故断言「唯一未包含行且含该分支名」而非全等
    expect(wrapper.findAll('.row-miss').map(w => w.text())).toEqual([expect.stringContaining('release/1.0')])
    expect(wrapper.findAll('.row-ok').map(w => w.text())).toEqual(expect.arrayContaining(['master', 'release/2.0']))
    // 行内含状态徽标文案，同样断言「唯一灰显行且含该分支名」
    expect(wrapper.findAll('.row-other').map(w => w.text())).toEqual([expect.stringContaining('tmp/x')])
    expect(otherIdx).toBeGreaterThan(-1)
  })

  it('复制按钮写入 cherry-pick 命令', async () => {
    const { wrapper } = await mountView()
    const btn = wrapper.findAll('button').find(b => b.text().includes('git cherry-pick'))!
    await btn.trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`git cherry-pick ${sha}`)
  })

  it('repo query 透传 inclusion 请求，缺省不拼 repo 参数', async () => {
    const { fetchMock } = await mountView('?repo=r2')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('repo=r2')

    const { fetchMock: bareMock } = await mountView()
    expect(String(bareMock.mock.calls[0]?.[0])).not.toContain('repo=')
  })
})
