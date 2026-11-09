<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, formatRelative, type CrossBranchesDto, type CrossCompareDto, type RepoDto } from '../api'

const route = useRoute()
const router = useRouter()
const repos = ref<RepoDto[]>([])
const repoA = ref((route.query.repoA as string) ?? '')
const repoB = ref((route.query.repoB as string) ?? '')
const branchA = ref((route.query.branchA as string) ?? '')
const branchB = ref((route.query.branchB as string) ?? '')
const includeGlob = ref((route.query.include as string) ?? '')
const excludeGlob = ref((route.query.exclude as string) ?? '')
const pairInfo = ref<CrossBranchesDto | null>(null)
const result = ref<CrossCompareDto | null>(null)
const error = ref('')

const splitGlobs = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)

// 下拉选项 = 本侧全部分支；对方缺失（未配对）的标注"(未配对)"并禁选，避免必然 404 的对比请求
function options(side: 'A' | 'B'): { name: string; unpaired: boolean }[] {
  const p = pairInfo.value
  if (!p) return []
  const own = side === 'A' ? p.repoA.branches : p.repoB.branches
  const other = side === 'A' ? p.repoB.branches : p.repoA.branches
  return own.map(n => ({ name: n, unpaired: !other.includes(n) }))
}

async function loadBranches(): Promise<void> {
  if (!repoA.value || !repoB.value) { pairInfo.value = null; return }
  try {
    const p = await api.crossBranches(repoA.value, repoB.value)
    pairInfo.value = p
    const preferred = p.paired[0] ?? ''
    if (!branchA.value || !p.repoA.branches.includes(branchA.value)) {
      branchA.value = preferred || p.repoA.branches[0] || ''
    }
    if (!branchB.value || !p.repoB.branches.includes(branchB.value)) {
      branchB.value = p.repoB.branches.includes(branchA.value)
        ? branchA.value
        : (preferred || p.repoB.branches[0] || '')
    }
    error.value = ''
  } catch (e) {
    pairInfo.value = null
    error.value = (e as Error).message
  }
}

async function load(): Promise<void> {
  if (!repoA.value || !repoB.value || !branchA.value || !branchB.value) { result.value = null; return }
  try {
    result.value = await api.crossCompare({
      repoA: repoA.value, repoB: repoB.value, branchA: branchA.value, branchB: branchB.value,
      include: splitGlobs(includeGlob.value), exclude: splitGlobs(excludeGlob.value)
    })
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
    result.value = null
  }
}

function syncQuery(): void {
  void router.replace({
    path: '/crossrepo',
    query: {
      repoA: repoA.value, repoB: repoB.value, branchA: branchA.value, branchB: branchB.value,
      ...(includeGlob.value ? { include: includeGlob.value } : {}),
      ...(excludeGlob.value ? { exclude: excludeGlob.value } : {})
    }
  })
}

async function onRepoChange(): Promise<void> {
  branchA.value = ''
  branchB.value = ''
  syncQuery()
  await loadBranches()
  await load()
}

function onCompare(): void {
  syncQuery()
  void load()
}

onMounted(async () => {
  try {
    repos.value = await api.repos()
    if (!repoA.value) repoA.value = repos.value[0]?.id ?? ''
    if (!repoB.value) repoB.value = (repos.value[1] ?? repos.value[0])?.id ?? ''
    await loadBranches()
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <section class="crossrepo">
    <div class="pick">
      <label>仓库 A <select v-model="repoA" @change="onRepoChange"><option v-for="r in repos" :key="r.id" :value="r.id">{{ r.id }}</option></select></label>
      <label>仓库 B <select v-model="repoB" @change="onRepoChange"><option v-for="r in repos" :key="r.id" :value="r.id">{{ r.id }}</option></select></label>
      <label>分支 A <select v-model="branchA" @change="onCompare"><option v-for="o in options('A')" :key="o.name" :value="o.name" :disabled="o.unpaired">{{ o.name }}{{ o.unpaired ? '（未配对）' : '' }}</option></select></label>
      <label>分支 B <select v-model="branchB" @change="onCompare"><option v-for="o in options('B')" :key="o.name" :value="o.name" :disabled="o.unpaired">{{ o.name }}{{ o.unpaired ? '（未配对）' : '' }}</option></select></label>
      <label>仅对比 <input v-model="includeGlob" placeholder="src/**,docs/**" /></label>
      <label>排除 <input v-model="excludeGlob" placeholder="vendor/**" /></label>
      <button class="btn" @click="onCompare">对比</button>
    </div>

    <p v-if="error" class="banner banner-red">{{ error }}</p>

    <template v-if="result">
      <p class="muted">
        A 共 {{ result.stats.aTotal }} · B 共 {{ result.stats.bTotal }} ·
        同补丁 {{ result.stats.matched }} ·
        {{ result.branchPair.repoA }} 独有 {{ result.stats.onlyA }} ·
        {{ result.branchPair.repoB }} 独有 {{ result.stats.onlyB }}
        <template v-if="result.unpairedBranches.repoA.length || result.unpairedBranches.repoB.length">
          · 未配对分支：{{ [...result.unpairedBranches.repoA, ...result.unpairedBranches.repoB].join('、') }}
        </template>
      </p>

      <h3>源码一致（同补丁）（{{ result.matchedPairs.length }}）</h3>
      <ul class="rows">
        <li v-for="m in result.matchedPairs" :key="m.patchId" class="row row-matched">
          <code>{{ m.shaA.slice(0, 12) }}</code> ↔ <code>{{ m.shaB.slice(0, 12) }}</code>
          {{ m.subjectA }}
        </li>
        <li v-if="result.matchedPairs.length === 0" class="muted">（无 —— 全部为单向独有改动）</li>
      </ul>

      <div class="cols">
        <div>
          <h3>{{ result.branchPair.repoA }} 独有（{{ result.onlyInA.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.onlyInA" :key="c.sha" class="row">
              <RouterLink :to="`/commit/${c.sha}${repoA ? `?repo=${repoA}` : ''}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.onlyInA.length === 0" class="muted">（无）</li>
          </ul>
        </div>
        <div>
          <h3>{{ result.branchPair.repoB }} 独有（{{ result.onlyInB.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.onlyInB" :key="c.sha" class="row">
              <RouterLink :to="`/commit/${c.sha}${repoB ? `?repo=${repoB}` : ''}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.onlyInB.length === 0" class="muted">（无）</li>
          </ul>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* style.css 不在本任务修改清单内：matched 灰色样式以 scoped 规则就近提供 */
.row-matched { background: #eaeef2; color: #57606a; }
@media (prefers-color-scheme: dark) {
  .row-matched { background: #21262d; color: #8b949e; }
}
.pick input { padding: 4px 8px; border-radius: 6px; border: 1px solid #d0d7de; }
</style>
