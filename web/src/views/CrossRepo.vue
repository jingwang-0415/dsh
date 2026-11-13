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
      repoA: repoA.value, repoB: repoB.value,
      // 分支为空时整个键不落 URL：避免切仓瞬间的 branchA=&branchB= 空参形态（URL 即状态，缺省 = 待派生）
      ...(branchA.value ? { branchA: branchA.value } : {}),
      ...(branchB.value ? { branchB: branchB.value } : {}),
      ...(includeGlob.value ? { include: includeGlob.value } : {}),
      ...(excludeGlob.value ? { exclude: excludeGlob.value } : {})
    }
  })
}

async function onRepoChange(): Promise<void> {
  branchA.value = ''
  branchB.value = ''
  await loadBranches()   // 先派生新默认分支（paired[0]），再回写 URL，避免把空分支写进 query
  syncQuery()
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
      <span>仓库 A</span>
      <!-- 四枚下拉均不在表格 cell 内 → teleported=false（弹层随布局渲染，可作用域查询） -->
      <el-select class="select-repo-a" v-model="repoA" :teleported="false" @change="onRepoChange">
        <el-option v-for="r in repos" :key="r.id" :label="r.id" :value="r.id" />
      </el-select>
      <span>仓库 B</span>
      <el-select class="select-repo-b" v-model="repoB" :teleported="false" @change="onRepoChange">
        <el-option v-for="r in repos" :key="r.id" :label="r.id" :value="r.id" />
      </el-select>
      <span>分支 A</span>
      <el-select class="select-branch-a" v-model="branchA" :teleported="false" @change="onCompare">
        <!-- 未配对禁选：el-option disabled + 文案标注（语义与原 disabled option 逐字一致） -->
        <el-option
          v-for="o in options('A')" :key="o.name"
          :label="o.name + (o.unpaired ? '（未配对）' : '')" :value="o.name" :disabled="o.unpaired"
        />
      </el-select>
      <span>分支 B</span>
      <el-select class="select-branch-b" v-model="branchB" :teleported="false" @change="onCompare">
        <el-option
          v-for="o in options('B')" :key="o.name"
          :label="o.name + (o.unpaired ? '（未配对）' : '')" :value="o.name" :disabled="o.unpaired"
        />
      </el-select>
      <span>仅对比</span>
      <el-input v-model="includeGlob" class="filter-include" placeholder="src/**,docs/**" />
      <span>排除</span>
      <el-input v-model="excludeGlob" class="filter-exclude" placeholder="vendor/**" />
      <el-button type="primary" @click="onCompare">对比</el-button>
    </div>

    <el-alert v-if="error" class="error-alert" type="error" :title="error" :closable="false" />

    <template v-if="result">
      <!-- 统计行：简化 el-row/el-col（映射指引二选一，取轻量版，数值语义逐键保留） -->
      <el-row class="stats-row" :gutter="8">
        <el-col :span="4"><span class="muted">A 共</span> {{ result.stats.aTotal }}</el-col>
        <el-col :span="4"><span class="muted">B 共</span> {{ result.stats.bTotal }}</el-col>
        <el-col :span="4"><span class="muted">同补丁</span> {{ result.stats.matched }}</el-col>
        <el-col :span="6"><span class="muted">{{ result.branchPair.repoA }} 独有</span> {{ result.stats.onlyA }}</el-col>
        <el-col :span="6"><span class="muted">{{ result.branchPair.repoB }} 独有</span> {{ result.stats.onlyB }}</el-col>
      </el-row>
      <p
        v-if="result.unpairedBranches.repoA.length || result.unpairedBranches.repoB.length"
        class="muted"
      >
        未配对分支：{{ [...result.unpairedBranches.repoA, ...result.unpairedBranches.repoB].join('、') }}
      </p>

      <h3>源码一致（同补丁）（{{ result.matchedPairs.length }}）</h3>
      <ul class="rows">
        <li v-for="m in result.matchedPairs" :key="m.patchId" class="row row-matched">
          <code>{{ m.shaA.slice(0, 12) }}</code> ↔ <code>{{ m.shaB.slice(0, 12) }}</code>
          {{ m.subjectA }}
        </li>
        <li v-if="result.matchedPairs.length === 0" class="muted">（无 —— 全部为单向独有改动）</li>
      </ul>

      <el-row :gutter="16">
        <el-col :span="12">
          <h3>{{ result.branchPair.repoA }} 独有（{{ result.onlyInA.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.onlyInA" :key="c.sha" class="row">
              <!-- 对象式 :to（v1.4）：query 交给 vue-router 统一编码——串拼接对 repo id 含
                   & 等保留字符会把查询串劈成两段；repo 未定（空串）时省 query，与旧语义一致 -->
              <RouterLink :to="{ path: '/commit/' + c.sha, query: repoA ? { repo: repoA } : undefined }"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.onlyInA.length === 0" class="muted">（无）</li>
          </ul>
        </el-col>
        <el-col :span="12">
          <h3>{{ result.branchPair.repoB }} 独有（{{ result.onlyInB.length }}）</h3>
          <ul class="rows">
            <li v-for="c in result.onlyInB" :key="c.sha" class="row">
              <RouterLink :to="{ path: '/commit/' + c.sha, query: repoB ? { repo: repoB } : undefined }"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
              <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
            </li>
            <li v-if="result.onlyInB.length === 0" class="muted">（无）</li>
          </ul>
        </el-col>
      </el-row>
    </template>
  </section>
</template>

<style scoped>
/* 布局就近提供（Repos 先例）：控件视觉交由 EP 组件与 html.dark 变量体系；matched 灰色
   保留语义就近提供，暗色分支随 T1 主题体系由 @media 改 html.dark 类驱动 */
.pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.pick .el-select { width: 170px; }
.pick .filter-include, .pick .filter-exclude { width: 200px; }
.stats-row { margin-bottom: 8px; align-items: baseline; }
.row-matched { background: #eaeef2; color: #57606a; }
html.dark .row-matched { background: #21262d; color: #8b949e; }
</style>
