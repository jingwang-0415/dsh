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
const copied = ref(false)

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

async function copyCherryPick(): Promise<void> {
  await navigator.clipboard.writeText(`git cherry-pick ${sha}`)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <section class="commit-detail">
    <p v-if="error" class="banner banner-red">加载失败：{{ error }}</p>
    <template v-if="commit">
      <header class="commit-head">
        <h2>{{ commit.subject }}</h2>
        <p class="muted">
          <code>{{ sha.slice(0, 10) }}</code>
          · {{ commit.authorName }} · {{ formatRelative(commit.committedAt) }}
          · 来自分支 {{ commit.firstSeenBranch }}
        </p>
        <pre v-if="commit.body" class="commit-body">{{ commit.body }}</pre>
      </header>

      <h3 class="sec-miss">未包含以下提交的分支（{{ missing.length }}）</h3>
      <ul class="rows">
        <li v-for="r in missing" :key="r.branch" class="row row-miss">
          <span class="dot dot-red" /> {{ r.branch }}
          <button class="btn" @click="copyCherryPick">复制 git cherry-pick {{ sha.slice(0, 10) }}</button>
        </li>
        <li v-if="missing.length === 0" class="muted">（无 —— 所有活跃分支都已包含该提交）</li>
      </ul>
      <p v-if="copied" class="muted">已复制到剪贴板 ✓</p>

      <h3 class="sec-ok">已包含的分支（{{ present.length }}）</h3>
      <ul class="rows">
        <li v-for="r in present" :key="r.branch" class="row row-ok">
          <span class="dot dot-green" /> {{ r.branch }}
          <span v-if="r.status === 'rewritten'" class="badge badge-gray">历史重写</span>
        </li>
      </ul>

      <details v-if="other.length">
        <summary>已删除/异常分支（{{ other.length }}）</summary>
        <ul class="rows">
          <li v-for="r in other" :key="r.branch" class="row row-other">
            <span class="dot dot-gray" /> {{ r.branch }}
            <span class="badge badge-gray">{{ r.status === 'deleted' ? '已删除' : '历史重写' }}</span>
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>
