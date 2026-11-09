<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type RepoConfigDto, type RepoDto, type StatusDto } from '../api'

const repos = ref<RepoDto[]>([])
const statuses = ref<Record<string, StatusDto | null>>({})
const error = ref('')

// 表单：id/url 必填，其余可选（缺省 = 服务端 zod default 填充 master/[]/30）
const formId = ref('')
const formUrl = ref('')
const formBranch = ref('')
const formInterval = ref('')
const formExclude = ref('')

// 前端先行校验：与服务端 repoSchema 契约对齐（id 同款白名单正则、url 非空、间隔为 ≥5 整数秒），
// 拦掉必败请求；服务端仍是唯一裁决（400/409/500 的 message/code 原样上横幅）
const ID_RE = /^[A-Za-z0-9._-]+$/

function validate(): string {
  if (!ID_RE.test(formId.value)) return 'id 仅允许字母数字与 . _ -'
  if (!formUrl.value.trim()) return 'url 不能为空'
  if (formInterval.value.trim()) {
    const n = Number(formInterval.value)
    if (!Number.isInteger(n) || n < 5) return '轮询间隔须为不小于 5 的整数秒'
  }
  return ''
}

async function refresh(): Promise<void> {
  try {
    const rs = await api.repos()
    repos.value = rs
    // 各仓调度状态徽标：单仓 status 失败不拖垮整表（该行降级"未知"）
    const entries = await Promise.all(
      rs.map(async r => [r.id, await api.status(r.id).catch(() => null)] as const)
    )
    statuses.value = Object.fromEntries(entries)
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function onAdd(): Promise<void> {
  const v = validate()
  if (v) { error.value = v; return }
  const body: RepoConfigDto = { id: formId.value, url: formUrl.value.trim() }
  if (formBranch.value.trim()) body.defaultBranch = formBranch.value.trim()
  const globs = formExclude.value.split(',').map(s => s.trim()).filter(Boolean)
  if (globs.length) body.branchExclude = globs
  if (formInterval.value.trim()) body.pollIntervalSeconds = Number(formInterval.value)
  try {
    await api.addRepo(body)
    formId.value = ''; formUrl.value = ''; formBranch.value = ''; formInterval.value = ''; formExclude.value = ''
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function onRemove(id: string): Promise<void> {
  // 删除语义与 server 一致：停调度 + 移出 config.json；DB 历史保留，同 id 重挂自动接续
  if (!window.confirm('确定停止监控并移除该仓库？历史数据将保留')) return
  try {
    await api.removeRepo(id)
    error.value = ''
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function badge(r: RepoDto): { cls: string; text: string } {
  const s = statuses.value[r.id]
  if (!s) return { cls: 'badge-gray', text: '未知' }
  switch (s.state) {
    case 'running': return { cls: 'badge-green', text: '监听中' }
    case 'idle': return { cls: 'badge-gray', text: '空闲' }
    case 'backoff': return { cls: 'badge-yellow', text: '重试中' }
    case 'starting': return { cls: 'badge-blue', text: '启动中' }
  }
}

onMounted(() => { void refresh() })
</script>

<template>
  <section class="repos">
    <h2>仓库管理</h2>
    <p v-if="error" class="banner banner-red">{{ error }}</p>

    <form class="add-form" @submit.prevent="onAdd">
      <label>id <input v-model="formId" placeholder="repo-id" /></label>
      <label>url <input v-model="formUrl" placeholder="https://example.com/beta.git" /></label>
      <label>默认分支 <input v-model="formBranch" placeholder="master" /></label>
      <label>轮询间隔秒 <input v-model="formInterval" placeholder="30" /></label>
      <label>排除 glob <input v-model="formExclude" placeholder="vendor/**,docs/**" /></label>
      <button class="btn" type="submit">添加</button>
    </form>

    <table class="tbl">
      <thead>
        <tr><th>id</th><th>url</th><th>默认分支</th><th>轮询间隔</th><th>调度状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in repos" :key="r.id">
          <td><code>{{ r.id }}</code></td>
          <td>{{ r.url }}</td>
          <td>{{ r.defaultBranch }}</td>
          <td>{{ r.pollIntervalSeconds }}s</td>
          <td><span class="badge" :class="badge(r).cls">{{ badge(r).text }}</span></td>
          <td><button class="btn" @click="onRemove(r.id)">删除</button></td>
        </tr>
      </tbody>
    </table>
    <p v-if="!repos.length" class="muted">暂无仓库——用上方表单添加第一个仓库。</p>
  </section>
</template>

<style scoped>
/* style.css 不在本任务修改清单内：表单布局以 scoped 规则就近提供（CrossRepo 先例） */
.add-form { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 16px; }
.add-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.add-form input { padding: 4px 8px; border-radius: 6px; border: 1px solid #d0d7de; min-width: 160px; }
</style>
