<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, connectEvents, formatRelative, type BranchRow, type StatusDto } from '../api'

const router = useRouter()
const status = ref<StatusDto | null>(null)
const defaultBranch = ref('master')
const branches = ref<BranchRow[]>([])
let es: EventSource | null = null

async function refresh(): Promise<void> {
  const [s, b, repos] = await Promise.all([api.status(), api.branches(), api.repos()])
  status.value = s
  branches.value = b
  defaultBranch.value = repos[0]?.defaultBranch ?? 'master'
}

onMounted(async () => {
  await refresh()
  es = connectEvents({
    onCommitsNew: () => void refresh(),
    onBranchesUpdated: () => void refresh(),
    onStatus: s => { if (status.value) status.value = s }
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
  if (s.consecutiveFailures > 0) return `监听重试中（第 ${s.consecutiveFailures} 次失败），下次重试 ${s.nextRunAt ? formatRelative(s.nextRunAt) : '稍后'}`
  return `监听正常 · 上次同步 ${s.lastRunAt ? formatRelative(s.lastRunAt) : '从未'}`
}
function openCompare(b: BranchRow): void {
  void router.push({ path: '/compare', query: { base: defaultBranch.value, target: b.name } })
}
</script>

<template>
  <section class="overview">
    <div class="banner" :class="bannerClass()">{{ bannerText() }}</div>
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
