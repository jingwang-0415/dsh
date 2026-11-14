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
      // 直接替换会把 mirrorDir/lastFetch 抹成 undefined，横幅的 lastFetch 判断随之失效
      if (status.value && s.repoId === repoId.value) { status.value = { ...status.value, ...s } } else { void refresh() }
    }
  })
})
onUnmounted(() => { es?.close() })

const active = (): BranchRow[] => branches.value.filter(b => b.status === 'active')
const deleted = (): BranchRow[] => branches.value.filter(b => b.status === 'deleted')

// v1.6 EP 迁移：连接状态为持续信息 → el-alert 四态 type（映射原 bannerClass 四分支，
// gray=连接中 → info、yellow=重试中 → warning、red=上轮失败 → error、green=正常 → success）
type AlertType = 'success' | 'warning' | 'error' | 'info'
function alertType(): AlertType {
  const s = status.value
  if (!s) return 'info'
  if (s.state === 'backoff' || s.consecutiveFailures > 0) return 'warning'
  if (s.lastFetch && s.lastFetch.status === 'failed') return 'error'
  return 'success'
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
// 请求期间 :loading 防连点；v1.6 EP 迁移：同步结果为瞬时信息 → ElMessage 三态
// （success=检出 N / info=进行中跳过或无新提交 / error=失败），连接状态仍走 el-alert（持久）；
// 完成后 refresh() 让状态条/分支行立即反映本轮 fetch
const syncing = ref(false)

async function onSyncNow(): Promise<void> {
  if (syncing.value || !repoId.value) return
  syncing.value = true
  // v1.4 切仓守卫：发起前捕获目标仓；消息落笔前比对当前仓——在飞切仓后，旧仓的迟到
  // 结果不得落进新仓语境（切仓只清得掉"已落笔"的持久横幅，拦不住 await 之后的回写）
  const targetRepo = repoId.value
  try {
    const r = await api.syncRepo(targetRepo)
    if (repoId.value !== targetRepo) return   // 切仓守卫：已离开目标仓 → 本轮结果整体不落消息
    if (!r.ok) {
      ElMessage.error(`同步失败：${r.error ?? '未知错误'}`)
    } else if (r.skipped) {
      // 自动轮询在飞被互斥跳过：非故障，info 消息 + 服务端文案兜底
      ElMessage.info(r.message ?? '已有同步在进行中')
    } else if ((r.newCommits ?? 0) > 0) {
      ElMessage.success(`手动同步完成：检出 ${r.newCommits} 个新提交`)
    } else {
      ElMessage.info('手动同步完成：无新提交')
    }
  } catch (e) {
    // sendJson 通道抛错（网络断开/HTTP 非 200）：message 透传（契约 message 优先 code 兜底）；
    // 抛错路径同款守卫——消息只属于发起时所在的仓
    if (repoId.value !== targetRepo) return
    ElMessage.error(`同步失败：${(e as Error).message}`)
  } finally {
    syncing.value = false
    await refresh()
  }
}

// 切仓：清掉旧仓瞬时消息（v1.6-T2fix 恢复旧语义：ElMessage 3s 自灭期间会残留到新仓语境）
// → 回写当前 query（URL 即状态）→ 按新仓刷新
function onRepoChange(): void {
  ElMessage.closeAll()
  void router.replace({ path: '/', query: repoId.value ? { repo: repoId.value } : {} })
  void refresh()
}
</script>

<template>
  <section class="overview">
    <div class="pick">
      <span class="pick-label">仓库</span>
      <!-- 仓库切换下拉：teleported=false 使弹层随布局渲染（窄侧栏不溢出），change 触发切仓守卫语义 -->
      <el-select v-model="repoId" class="repo-select" :teleported="false" @change="onRepoChange">
        <el-option v-for="r in repos" :key="r.id" :label="r.id" :value="r.id" />
      </el-select>
      <el-button @click="router.push('/repos')">仓库管理</el-button>
    </div>
    <div class="status-row">
      <!-- 连接状态横幅：持续信息 → el-alert 四态 + CLOSABLE=false（不可手动关闭） -->
      <el-alert class="status-alert" :type="alertType()" :title="bannerText()" :closable="false" />
      <!-- v1.3.2 手动同步：未选中仓（初始加载）或在飞（:loading）时禁用 -->
      <el-button
        class="sync-btn" type="primary" :loading="syncing" :disabled="!repoId"
        title="立即拉取该仓远端（与自动轮询互斥安全）" @click="onSyncNow"
      >立即同步</el-button>
    </div>
    <el-alert v-if="error" class="error-alert" type="error" :title="`加载失败：${error}`" :closable="false" />
    <p v-if="status?.lastError" class="muted err">最近错误：{{ status.lastError }}</p>

    <el-table :data="active()" class="branch-table">
      <el-table-column label="分支" min-width="200">
        <template #default="{ row }">
          <span class="branch-name">{{ row.name }}</span>
          <el-tag v-if="row.name === defaultBranch" size="small">默认</el-tag>
          <el-tag v-if="row.rewritten" size="small" type="info" effect="plain">历史重写</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最新提交" min-width="220">
        <template #default="{ row }">{{ row.lastSubject ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="作者">
        <template #default="{ row }">{{ row.lastAuthor ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="时间">
        <template #default="{ row }">{{ row.lastCommitAt ? formatRelative(row.lastCommitAt) : '—' }}</template>
      </el-table-column>
      <el-table-column label="落后默认分支" align="center">
        <template #default="{ row }">
          <!-- 落后徽标：el-badge 计数 + el-link 保留路由跳转语义（进 /compare 对比默认分支） -->
          <el-badge v-if="(row.behindDefault ?? 0) > 0" :value="row.behindDefault" type="warning">
            <el-link type="warning" underline="never" @click="openCompare(row as BranchRow)">落后</el-link>
          </el-badge>
          <span v-else class="muted">0</span>
        </template>
      </el-table-column>
      <el-table-column label="新提交" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.recentCommits > 0" size="small" type="danger">{{ row.recentCommits }}</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
    </el-table>

    <details v-if="deleted().length">
      <summary>已删除分支（{{ deleted().length }}）</summary>
      <ul class="rows">
        <li v-for="b in deleted()" :key="b.name" class="row row-other">{{ b.name }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
/* v1.3.2 手动同步：状态条与按钮同行（el-alert 弹性占满剩余宽度，按钮固定右侧） */
.status-row { display: flex; align-items: center; gap: 8px; }
.status-row .status-alert { flex: 1; margin-bottom: 8px; }
.sync-btn { flex-shrink: 0; }
/* 仓库切换行：el-select 定宽（EP 无原生 select 的内建宽度）；响应式 hotfix 补 wrap——
   窄屏下按钮换行不再挤压 select（.repo-select 200px 定宽保留，单控件场景宽度合理） */
.pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.repo-select { width: 200px; }
/* 表格内徽标与行内容的间距（el-tag 无内建右距） */
.branch-name { margin-right: 6px; }
.branch-table :deep(.el-tag) { margin-right: 4px; }
</style>
