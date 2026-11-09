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
      // 初始 refresh 失败时 status 恒为 null，借 SSE 推送触发一次重新拉取完成自愈
      if (status.value && s.repoId === repoId.value) { status.value = s } else { void refresh() }
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

// 切仓：回写当前 query（URL 即状态），再按新仓刷新
function onRepoChange(): void {
  void router.replace({ path: '/', query: repoId.value ? { repo: repoId.value } : {} })
  void refresh()
}
</script>

<template>
  <section class="overview">
    <div class="pick">
      <label>仓库 <select v-model="repoId" @change="onRepoChange"><option v-for="r in repos" :key="r.id" :value="r.id">{{ r.id }}</option></select></label>
    </div>
    <div class="banner" :class="bannerClass()">{{ bannerText() }}</div>
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
