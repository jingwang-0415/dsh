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
      <label>仓库 <select v-model="repoId" @change="onRepoChange"><option v-for="r in repos" :key="r.id" :value="r.id">{{ r.id }}</option></select></label>
      <label>基准 <select v-model="base"><option v-for="n in names" :key="n" :value="n">{{ n }}</option></select></label>
      <label>目标 <select v-model="target"><option v-for="n in names" :key="n" :value="n">{{ n }}</option></select></label>
    </div>
    <p v-if="error" class="banner banner-red">{{ error }}</p>
    <p v-if="result" class="muted">
      {{ base }} 领先 {{ target }} <strong>{{ result.ahead }}</strong> 个提交，
      落后 <strong>{{ result.behind }}</strong> 个提交
    </p>

    <div v-if="result" class="cols">
      <div>
        <h3>{{ base }} 独有（{{ result.aheadCommits.length }}）</h3>
        <ul class="rows">
          <li v-for="c in result.aheadCommits" :key="c.sha" class="row">
            <RouterLink :to="`/commit/${c.sha}${repoId ? `?repo=${repoId}` : ''}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.aheadCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
      <div>
        <h3>{{ target }} 独有（{{ result.behindCommits.length }}）</h3>
        <ul class="rows">
          <li v-for="c in result.behindCommits" :key="c.sha" class="row">
            <RouterLink :to="`/commit/${c.sha}${repoId ? `?repo=${repoId}` : ''}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.behindCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
    </div>
  </section>
</template>
