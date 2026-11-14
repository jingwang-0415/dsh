<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, formatRelative, type CommitRow, type InclusionRow } from '../api'

const route = useRoute()
const sha = route.params.sha as string
// repo 作用域：跨仓直链等入口带 ?repo= 时按该仓解析（缺省服务端取第一仓）
const repo = route.query.repo as string | undefined
const commit = ref<CommitRow | null>(null)
const results = ref<InclusionRow[]>([])
const error = ref('')

const missing = computed(() => results.value.filter(r => !r.contains && r.status === 'active'))
const present = computed(() => results.value.filter(r => r.contains))
const other = computed(() => results.value.filter(r => !r.contains && r.status !== 'active'))

onMounted(async () => {
  try {
    const data = await api.commitInclusion(sha, repo)
    commit.value = data.commit
    results.value = data.results
  } catch (e) {
    error.value = (e as Error).message
  }
})

// v1.6 EP 迁移：复制反馈由持久 muted 文案（copied ref + setTimeout 复位）改为 ElMessage
// 瞬时成功提示（Overview 手动同步同款通道）；剪贴板载荷 `git cherry-pick <sha>` 语义不变。
// 「Enter 保存」核对：git -p 全历史无此语义（现行实现即复制按钮），简报该项无对应物
async function copyCherryPick(): Promise<void> {
  await navigator.clipboard.writeText(`git cherry-pick ${sha}`)
  ElMessage.success('已复制到剪贴板')
}
</script>

<template>
  <section class="commit-detail">
    <el-alert v-if="error" class="error-alert" type="error" :title="`加载失败：${error}`" :closable="false" />
    <template v-if="commit">
      <header class="commit-head">
        <h2>{{ commit.subject }}</h2>
        <!-- 提交头元信息：el-descriptions（sha/作者/时间/来源分支，subject 保留 h2 标题位） -->
        <el-descriptions class="commit-meta" :column="2" border size="small">
          <el-descriptions-item label="commit"><code>{{ sha.slice(0, 10) }}</code></el-descriptions-item>
          <el-descriptions-item label="作者">{{ commit.authorName }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatRelative(commit.committedAt) }}</el-descriptions-item>
          <el-descriptions-item label="来自分支">{{ commit.firstSeenBranch }}</el-descriptions-item>
        </el-descriptions>
        <pre v-if="commit.body" class="commit-body">{{ commit.body }}</pre>
      </header>

      <!-- 三分支分区语义（未包含置顶 / 已包含 / 其他折叠）：行状态色 dot+底色 → el-tag type
           danger（未包含）/ success（已包含）/ info（其他），分区次序不变 -->
      <h3>未包含以下提交的分支（{{ missing.length }}）</h3>
      <ul class="rows sec-miss">
        <li v-for="r in missing" :key="r.branch" class="row">
          <el-tag type="danger">{{ r.branch }}</el-tag>
          <el-button size="small" @click="copyCherryPick">复制 git cherry-pick {{ sha.slice(0, 10) }}</el-button>
        </li>
        <li v-if="missing.length === 0" class="muted">（无 —— 所有活跃分支都已包含该提交）</li>
      </ul>

      <h3>已包含的分支（{{ present.length }}）</h3>
      <ul class="rows sec-ok">
        <li v-for="r in present" :key="r.branch" class="row">
          <el-tag type="success">{{ r.branch }}</el-tag>
          <el-tag v-if="r.status === 'rewritten'" type="info" effect="plain">历史重写</el-tag>
        </li>
      </ul>

      <!-- 其他（已删除/异常）分支：details → el-collapse 折叠 -->
      <el-collapse v-if="other.length" class="sec-other">
        <el-collapse-item :title="`已删除/异常分支（${other.length}）`">
          <ul class="rows">
            <li v-for="r in other" :key="r.branch" class="row">
              <el-tag type="info">{{ r.branch }}</el-tag>
              <el-tag type="info" effect="plain">{{ r.status === 'deleted' ? '已删除' : '历史重写' }}</el-tag>
            </li>
          </ul>
        </el-collapse-item>
      </el-collapse>
    </template>
  </section>
</template>

<style scoped>
/* 布局就近提供（Repos 先例）：视觉（边框/暗色/状态色）交由 EP 组件与 html.dark 变量体系 */
.commit-head { margin-bottom: 4px; }
.commit-meta { margin-top: 8px; }
</style>
