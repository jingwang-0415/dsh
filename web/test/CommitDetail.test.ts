import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'
import CommitDetail from '../src/views/CommitDetail.vue'

// v1.6-T3 Element Plus 迁移：DOM 定位适配 EP 结构（el-descriptions 提交头 / el-tag
// danger·success·info 三分区 / el-collapse 折叠 / el-button + ElMessage 复制反馈），
// 业务断言逐字保留（三分支语义与置顶顺序 / 复制剪贴板载荷 / repo query 透传）。
// EP 陷阱复用 T2 探针结论（勿再踩坑）：
// - VTU 默认 stub transition 会吞 el-tag/el-collapse 内层根 → mount 统一 stubs.transition=false
// - ElMessage 落 document.body → closeAll + 节点清理防跨用例串扰
// - 原 .row-miss/.row-ok/.row-other/.dot-*/.badge-* 手写行类迁 el-tag 后消亡（style.css 同步清理）
// 「Enter 保存」核对结论：git -p 全历史无任何 Enter/keyup 语义（现行实现即复制按钮），
// 简报该项无对应物、无需保持；复制反馈由持久 muted 文案改为 ElMessage 成功提示（映射指引）

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
  const wrapper: VueWrapper = mount(CommitDetail, { global: { plugins: [router], stubs: { transition: false } } })
  await flushPromises()
  return { wrapper, fetchMock }
}

// ElMessage 落 document.body（VTU wrapper 之外，Overview.test.ts 同款模式）
const messageNodes = (): HTMLElement[] => Array.from(document.querySelectorAll('.el-message'))

describe('CommitDetail 视图', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // 瞬时消息不跨用例串扰（Overview.test.ts 同款清理）
    ElMessage.closeAll()
    document.querySelectorAll('.el-message').forEach(n => n.remove())
  })

  it('未包含 danger 置顶分区，已包含 success 其后，删除分支 info 折叠', async () => {
    const { wrapper } = await mountView()
    const html = wrapper.html()
    const missIdx = html.indexOf('release/1.0')
    const okIdx = html.indexOf('release/2.0')
    const otherIdx = html.indexOf('tmp/x')
    expect(missIdx).toBeGreaterThan(-1)
    expect(missIdx).toBeLessThan(okIdx)           // 未包含在已包含之前（置顶语义）
    // 三分支语义按 el-tag type 分组断言（danger=未包含 / success=已包含 / info=其他）
    expect(wrapper.findAll('.sec-miss .el-tag--danger').map(t => t.text()))
      .toEqual(['release/1.0'])
    expect(wrapper.findAll('.sec-ok .el-tag--success').map(t => t.text()))
      .toEqual(expect.arrayContaining(['master', 'release/2.0']))
    expect(wrapper.findAll('.sec-other .el-tag--info').map(t => t.text()))
      .toEqual(expect.arrayContaining(['tmp/x']))
    expect(otherIdx).toBeGreaterThan(-1)
  })

  it('复制按钮写入 cherry-pick 命令并弹 ElMessage 成功提示', async () => {
    const { wrapper } = await mountView()
    const btn = wrapper.findAll('button').find(b => b.text().includes('git cherry-pick'))!
    await btn.trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`git cherry-pick ${sha}`)
    const msgs = messageNodes()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].classList.contains('el-message--success')).toBe(true)
    expect(msgs[0].textContent).toContain('已复制到剪贴板')
  })

  it('repo query 透传 inclusion 请求，缺省不拼 repo 参数', async () => {
    const { fetchMock } = await mountView('?repo=r2')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('repo=r2')

    const { fetchMock: bareMock } = await mountView()
    expect(String(bareMock.mock.calls[0]?.[0])).not.toContain('repo=')
  })
})
