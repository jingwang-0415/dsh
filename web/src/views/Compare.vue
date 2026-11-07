<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, formatRelative, type BranchRow, type CompareDto } from '../api'

const route = useRoute()
const router = useRouter()
const names = ref<string[]>([])
const base = ref((route.query.base as string) ?? '')
const target = ref((route.query.target as string) ?? '')
const result = ref<CompareDto | null>(null)
const error = ref('')

async function loadBranches(): Promise<void> {
  const rows: BranchRow[] = await api.branches()
  names.value = rows.filter(r => r.status === 'active').map(r => r.name)
  if (!base.value) base.value = names.value[0] ?? ''
  if (!target.value) target.value = names.value[1] ?? base.value
  await load()
}

async function load(): Promise<void> {
  if (!base.value || !target.value || base.value === target.value) { result.value = null; return }
  try {
    result.value = await api.compare(base.value, target.value)
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
    result.value = null
  }
}

watch([base, target], () => {
  void router.replace({ path: '/compare', query: { base: base.value, target: target.value } })
  void load()
})

onMounted(() => { void loadBranches() })
</script>

<template>
  <section class="compare">
    <div class="pick">
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
            <RouterLink :to="`/commit/${c.sha}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.aheadCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
      <div>
        <h3>{{ target }} 独有（{{ result.behindCommits.length }}）</h3>
        <ul class="rows">
          <li v-for="c in result.behindCommits" :key="c.sha" class="row">
            <RouterLink :to="`/commit/${c.sha}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.behindCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
    </div>
  </section>
</template>
