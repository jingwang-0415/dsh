<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, connectEvents, formatFuture, formatRelative, type BranchRow, type RepoDto, type StatusDto } from '../api'

const route = useRoute()
const router = useRouter()
const status = ref<StatusDto | null>(null)
const defaultBranch = ref('master')
const branches = ref<BranchRow[]>([])
const repos = ref<RepoDto[]>([])
// URL 即状态（沿用 CrossRepo 先例）：初始取 ?repo=，切仓后 onRepoChange 回写 query
const repoId = ref((route.query.repo as string) ?? '')
const error = ref('')
let es: EventSource | null = null

async function refresh(): Promise<void> {
  try {
    const scope = repoId.value || undefined
    const [s, b, rs] = await Promise.all([api.status(scope), api.branches(scope), api.repos()])
    status.value = s
    branches.value = b
    repos.value = rs
    const cur = rs.find(r => r.id === repoId.value) ?? rs[0]
    defaultBranch.value = cur?.defaultBranch ?? 'master'
    if (!repoId.value && cur) repoId.value = cur.id
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(async () => {
  try {
    await refresh()
  } catch {
    // refresh 内部已捕获并写入 error，此处兜底保证 SSE 仍建立
  }
  es = connectEvents({
    // v1.1 SSE 载荷带 repoId（多仓）：本页只盯当前选中仓，repoId 值有意忽略——
    // 其余仓的事件只会多触发一次幂等重拉，数据仍正确，不值得为省一次拉取引入过滤状态
    onCommitsNew: () => void refresh(),
    onBranchesUpdated: () => void refresh(),
    onStatus: s => {
      // 只认当前选中仓的 status 推送：其余仓的调度状态不覆写本页横幅；
      // 初始 refresh 失败时 status 恒为 null，借 SSE 推送触发一次重新拉取完成自愈。
      // SSE 载荷是 SchedulerStatus+repoId（无 mirrorDir/lastFetch），合并而非整体替换：
      // 直接替换会把 mirrorDir/lastFetch 抹成 undefined，bannerClass 的 lastFetch 判断随之失效
      if (status.value && s.repoId === repoId.value) { status.value = { ...status.value, ...s } } else { void refresh() }
    }
  })
})
onUnmounted(() => { es?.close() })

const active = (): BranchRow[] => branches.value.filter(b => b.status === 'active')
const deleted = (): BranchRow[] => branches.value.filter(b => b.status === 'deleted')

function bannerClass(): string {
  const s = status.value
  if (!s) return 'banner-gray'
  if (s.state === 'backoff' || s.consecutiveFailures > 0) return 'banner-yellow'
  if (s.lastFetch && s.lastFetch.status === 'failed') return 'banner-red'
  return 'banner-green'
}
function bannerText(): string {
  const s = status.value
  if (!s) return '连接中…'
  if (s.consecutiveFailures > 0) return `监听重试中（第 ${s.consecutiveFailures} 次失败），下次重试 ${s.nextRunAt ? formatFuture(s.nextRunAt) : '稍后'}`
  return `监听正常 · 上次同步 ${s.lastRunAt ? formatRelative(s.lastRunAt) : '从未'}`
}
function openCompare(b: BranchRow): void {
  void router.push({ path: '/compare', query: { repo: repoId.value, base: defaultBranch.value, target: b.name } })
}

// v1.3.2 手动同步（追加需求）：状态条右侧"立即同步"按钮 → POST /api/repos/:id/sync。
// 请求期间 disabled 防连点；结果写横幅（绿=检出 N / 灰=进行中跳过或无新提交 / 红=失败）；
// 完成后 refresh() 让状态条/分支行立即反映本轮 fetch
const syncing = ref(false)
const syncNote = ref<{ cls: string; text: string } | null>(null)

async function onSyncNow(): Promise<void> {
  if (syncing.value || !repoId.value) return
  syncing.value = true
  // v1.4 切仓守卫：发起前捕获目标仓；横幅落笔前比对当前仓——在飞切仓后，旧仓的迟到
  // 结果不得落进新仓语境（onRepoChange 只清得掉"已落笔"的横幅，拦不住 await 之后的回写）
  const targetRepo = repoId.value
  try {
    const r = await api.syncRepo(targetRepo)
    if (repoId.value !== targetRepo) return   // 切仓守卫：已离开目标仓 → 本轮结果整体不落横幅
    if (!r.ok) {
      syncNote.value = { cls: 'banner-red', text: `同步失败：${r.error ?? '未知错误'}` }
    } else if (r.skipped) {
      // 自动轮询在飞被互斥跳过：非故障，灰横幅 + 服务端文案兜底
      syncNote.value = { cls: 'banner-gray', text: r.message ?? '已有同步在进行中' }
    } else if ((r.newCommits ?? 0) > 0) {
      syncNote.value = { cls: 'banner-green', text: `手动同步完成：检出 ${r.newCommits} 个新提交` }
    } else {
      syncNote.value = { cls: 'banner-gray', text: '手动同步完成：无新提交' }
    }
  } catch (e) {
    // sendJson 通道抛错（网络断开/HTTP 非 200）：message 透传（契约 message 优先 code 兜底）；
    // 抛错路径同款守卫——横幅只属于发起时所在的仓
    if (repoId.value !== targetRepo) return
    syncNote.value = { cls: 'banner-red', text: `同步失败：${(e as Error).message}` }
  } finally {
    syncing.value = false
    await refresh()
  }
}

// 切仓：回写当前 query（URL 即状态），再按新仓刷新；手动同步横幅属上一仓结果，一并清掉
function onRepoChange(): void {
  syncNote.value = null
  void router.replace({ path: '/', query: repoId.value ? { repo: repoId.value } : {} })
  void refresh()
}
</script>

<template>
  <section class="overview">
    <div class="pick">
      <label>仓库 <select v-model="repoId" @change="onRepoChange"><option v-for="r in repos" :key="r.id" :value="r.id">{{ r.id }}</option></select></label>
      <button class="btn" @click="router.push('/repos')">仓库管理</button>
    </div>
    <div class="status-row">
      <div class="banner" :class="bannerClass()">{{ bannerText() }}</div>
      <!-- v1.3.2 手动同步：未选中仓（初始加载）或在飞时禁用 -->
      <button class="btn sync-btn" :disabled="syncing || !repoId" title="立即拉取该仓远端（与自动轮询互斥安全）" @click="onSyncNow">立即同步</button>
    </div>
    <p v-if="syncNote" class="banner sync-note" :class="syncNote.cls">{{ syncNote.text }}</p>
    <p v-if="error" class="banner banner-red">加载失败：{{ error }}</p>
    <p v-if="status?.lastError" class="muted err">最近错误：{{ status.lastError }}</p>

    <table class="tbl">
      <thead>
        <tr><th>分支</th><th>最新提交</th><th>作者</th><th>时间</th><th>落后默认分支</th><th>新提交</th></tr>
      </thead>
      <tbody>
        <tr v-for="b in active()" :key="b.name">
          <td>
            {{ b.name }}
            <span v-if="b.name === defaultBranch" class="badge badge-blue">默认</span>
            <span v-if="b.rewritten" class="badge badge-gray">历史重写</span>
          </td>
          <td>{{ b.lastSubject ?? '—' }}</td>
          <td>{{ b.lastAuthor ?? '—' }}</td>
          <td>{{ b.lastCommitAt ? formatRelative(b.lastCommitAt) : '—' }}</td>
          <td>
            <button v-if="(b.behindDefault ?? 0) > 0" class="badge badge-yellow" @click="openCompare(b)">
              落后 {{ b.behindDefault }} ↑
            </button>
            <span v-else class="muted">0</span>
          </td>
          <td>
            <span v-if="b.recentCommits > 0" class="badge badge-red">{{ b.recentCommits }}</span>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <details v-if="deleted().length">
      <summary>已删除分支（{{ deleted().length }}）</summary>
      <ul class="rows">
        <li v-for="b in deleted()" :key="b.name" class="row row-other">{{ b.name }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
/* v1.3.2 手动同步：状态条与按钮同行（按钮固定右侧，状态条占满剩余宽度） */
.status-row { display: flex; align-items: center; gap: 8px; }
.status-row .banner { flex: 1; margin-bottom: 8px; }
.sync-btn { flex-shrink: 0; }
.sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sync-note { margin-top: 0; }
</style>
