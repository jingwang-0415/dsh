<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, formatRelative, type BranchRow, type CompareDto, type RepoDto } from '../api'

const route = useRoute()
const router = useRouter()
const repos = ref<RepoDto[]>([])
const repoId = ref((route.query.repo as string) ?? '')
const names = ref<string[]>([])
const base = ref((route.query.base as string) ?? '')
const target = ref((route.query.target as string) ?? '')
const result = ref<CompareDto | null>(null)
const error = ref('')

// 分支下拉随仓联动：branches 按当前仓拉取（缺省语义与服务端第一仓一致）
async function loadBranches(): Promise<void> {
  const rows: BranchRow[] = await api.branches(repoId.value || undefined)
  names.value = rows.filter(r => r.status === 'active').map(r => r.name)
  if (!base.value) base.value = names.value[0] ?? ''
  if (!target.value) target.value = names.value[1] ?? base.value
  await load()
}

async function load(): Promise<void> {
  if (!base.value || !target.value || base.value === target.value) { result.value = null; return }
  try {
    result.value = await api.compare(base.value, target.value, repoId.value || undefined)
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
    result.value = null
  }
}

function syncQuery(): void {
  void router.replace({
    path: '/compare',
    query: {
      ...(repoId.value ? { repo: repoId.value } : {}),
      base: base.value, target: target.value
    }
  })
}

watch([base, target], () => {
  syncQuery()
  void load()
})

// 切仓：旧分支名不再适用于新仓，清空后按新仓分支重选默认位并重新对比
async function onRepoChange(): Promise<void> {
  base.value = ''
  target.value = ''
  syncQuery()
  await loadBranches()
  await load()
}

onMounted(async () => {
  try {
    repos.value = await api.repos()
    if (!repoId.value) repoId.value = repos.value[0]?.id ?? ''
    await loadBranches()
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <section class="compare">
    <div class="pick">
      <span>仓库</span>
      <el-select class="select-repo" v-model="repoId" :teleported="false" @change="onRepoChange">
        <el-option v-for="r in repos" :key="r.id" :label="r.id" :value="r.id" />
      </el-select>
      <span>基准</span>
      <el-select class="select-base" v-model="base" :teleported="false">
        <el-option v-for="n in names" :key="n" :label="n" :value="n" />
      </el-select>
      <span>目标</span>
      <el-select class="select-target" v-model="target" :teleported="false">
        <el-option v-for="n in names" :key="n" :label="n" :value="n" />
      </el-select>
    </div>
    <el-alert v-if="error" class="error-alert" type="error" :title="error" :closable="false" />

    <template v-if="result">
      <!-- 方向统计：业务文案逐字保留，ahead/behind 数值以 el-tag（success/warning）承载 -->
      <p class="muted dir-line">
        {{ base }} 领先 {{ target }}
        <el-tag type="success" size="small">{{ result.ahead }}</el-tag> 个提交，落后
        <el-tag type="warning" size="small">{{ result.behind }}</el-tag> 个提交
      </p>

      <el-row :gutter="16">
        <el-col :span="12">
          <h3>{{ base }} 独有（{{ result.aheadCommits.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.aheadCommits" :key="c.sha" class="row">
              <!-- 对象式 :to（CrossRepo 先例）：query 交给 vue-router 统一编码——串拼接对 repo id 含
                   & 等保留字符会把查询串劈成两段；repo 未定（空串）时省 query，与旧语义一致 -->
              <RouterLink :to="{ path: '/commit/' + c.sha, query: repoId ? { repo: repoId } : undefined }"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.aheadCommits.length === 0" class="muted">（无）</li>
          </ul>
        </el-col>
        <el-col :span="12">
          <h3>{{ target }} 独有（{{ result.behindCommits.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.behindCommits" :key="c.sha" class="row">
              <RouterLink :to="{ path: '/commit/' + c.sha, query: repoId ? { repo: repoId } : undefined }"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.behindCommits.length === 0" class="muted">（无）</li>
          </ul>
        </el-col>
      </el-row>
    </template>
  </section>
</template>

<style scoped>
/* 布局就近提供（Repos 先例）：控件视觉交由 EP 组件与 html.dark 变量体系 */
.pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.pick .el-select { width: 180px; }
.dir-line { margin-top: 0; }
</style>
