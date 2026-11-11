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
// v1.4 网络连接方式：代理三态（system=跟随系统 git 配置，默认/none=强制直连（无代理）/custom=显式代理）
type ProxyMode = 'system' | 'none' | 'custom'
const formBypass = ref(false)
const formProxyMode = ref<ProxyMode>('system')
const formProxy = ref('')

// 代理三态载荷构造（v1.4，POST 与 PATCH 共用同一构造；契约见 server repoSchema/PATCH：
// undefined=跟随系统 git 配置、''=强制无代理、非空=显式代理）：
// - bypassGitConfig 恒带 boolean（"是否绕过系统 git 配置"独立开关，与代理三态正交）
// - custom → httpProxy:<输入值>；none → httpProxy:''
// - system 态按目标分：PATCH → httpProxy:null（JSON Merge Patch 显式 unset，服务端删字段，
//   已设代理的仓可经 UI 还原为跟随系统；省键会被服务端理解为"不改动"，承载不了该语义）；
//   POST → 省键（新建即跟随系统）。custom 且输入为空被 validate 先行拦截，此处兜底按目标
//   语义处理：patch → httpProxy:null（显式 unset）、post → 省键——绝不静默降级成另一态
function transportFields(bypass: boolean, mode: ProxyMode, proxyRaw: string, target: 'post' | 'patch'): { bypassGitConfig: boolean; httpProxy?: string | null } {
  const proxy = proxyRaw.trim()
  const proxyField: { httpProxy?: string | null } =
    mode === 'custom' && proxy ? { httpProxy: proxy }
      : mode === 'none' ? { httpProxy: '' }
        : target === 'patch' ? { httpProxy: null }
          : {}
  return { bypassGitConfig: bypass, ...proxyField }
}

// T1 裁定：GET 行 httpProxy 未设省键（DTO optional）——读取一律经此兜底，
// 表格标记与编辑预填共用，键省略时不误渲染"代理"/不误预填
const bypassOf = (r: RepoDto): boolean => r.bypassGitConfig ?? false
const proxyOf = (r: RepoDto): string => ('httpProxy' in r ? (r.httpProxy ?? '') : '')
// 省键 → system、'' → none、非空 → custom（表格四态判定与编辑预填共用）
const proxyModeOf = (r: RepoDto): ProxyMode => {
  const raw = 'httpProxy' in r ? r.httpProxy : undefined
  return raw === undefined ? 'system' : raw === '' ? 'none' : 'custom'
}

// 前端先行校验：与服务端 repoSchema 契约对齐（id 同款白名单正则、url 非空、间隔为 ≥5 整数秒），
// 拦掉必败请求；服务端仍是唯一裁决（400/409/500 的 message/code 原样上横幅）
const ID_RE = /^[A-Za-z0-9._-]+$/

function validate(): string {
  // '.'/'..' 过白名单正则但 mirrorDir 会逃逸出 repos/（服务端 repoSchema 同款 refine），
  // 前端先行拦住；服务端仍是唯一裁决
  if (formId.value === '.' || formId.value === '..') return 'id 不能为 . 或 ..'
  if (!ID_RE.test(formId.value)) return 'id 仅允许字母数字与 . _ -'
  if (!formUrl.value.trim()) return 'url 不能为空'
  if (formInterval.value.trim()) {
    const n = Number(formInterval.value)
    if (!Number.isInteger(n) || n < 5) return '轮询间隔须为不小于 5 的整数秒'
  }
  // custom 态空地址先拦：载荷分支按态说话，不留"选了自定义却发出另一态"的静默错位
  if (formProxyMode.value === 'custom' && !formProxy.value.trim()) return '已选"通过代理服务器连接"：代理地址不能为空'
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
  Object.assign(body, transportFields(formBypass.value, formProxyMode.value, formProxy.value, 'post'))
  try {
    await api.addRepo(body)
    formId.value = ''; formUrl.value = ''; formBranch.value = ''; formInterval.value = ''; formExclude.value = ''
    formBypass.value = false; formProxyMode.value = 'system'; formProxy.value = ''
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

// v1.3.1 行内编辑：一次只允许一行进入编辑态（editingId 定位目标行）。
// url/id 是仓的身份键不可改（编辑态只读展示 + title 提示），可编辑的只有
// pollIntervalSeconds/defaultBranch/branchExclude 三键 + v1.4 网络连接方式三态——与 PATCH 白名单契约一致
const editingId = ref('')
const editBranch = ref('')
const editInterval = ref('')
const editExclude = ref('')
const editBypass = ref(false)
const editProxyMode = ref<ProxyMode>('system')
const editProxy = ref('')
const URL_IMMUTABLE_HINT = 'url 不可修改，更换地址请删除后重新添加'

function startEdit(r: RepoDto): void {
  editingId.value = r.id
  editBranch.value = r.defaultBranch
  editInterval.value = String(r.pollIntervalSeconds)
  editExclude.value = (r.branchExclude ?? []).join(',')
  editBypass.value = bypassOf(r)
  editProxyMode.value = proxyModeOf(r)
  editProxy.value = proxyOf(r)
  error.value = ''
}

function cancelEdit(): void {
  editingId.value = ''
  error.value = ''
}

// 前端先行校验同后端阈值（整数 ≥5 / 上限 604800=7 天，与 repoSchema .max / PATCH 校验
// 同阈值 / 非空分支），拦掉必败请求；服务端仍是唯一裁决。
// 上界防 setTimeout >2^31-1ms 钳 1ms：≥2147484 秒会让调度器变连续 fetch 循环。
// v-model 在 type=number 输入上会自动数值化（looseToNumber），故先 String() 归一再校验
const MAX_POLL_INTERVAL_SECONDS = 604800

function validateEdit(): string {
  const raw = String(editInterval.value).trim()
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 5) return '轮询间隔须为不小于 5 的整数秒'
  if (n > MAX_POLL_INTERVAL_SECONDS) return `轮询间隔上限 ${MAX_POLL_INTERVAL_SECONDS} 秒（7 天）`
  if (!editBranch.value.trim()) return '默认分支不能为空'
  // 与添加表单同款先行拦截：custom 态空地址不发 PATCH
  if (editProxyMode.value === 'custom' && !editProxy.value.trim()) return '已选"通过代理服务器连接"：代理地址不能为空'
  return ''
}

async function onSave(): Promise<void> {
  const v = validateEdit()
  if (v) { error.value = v; return }
  try {
    // 载荷白名单（无 url/id）；排除 glob 逗号拆分（与添加表单同款 filter(Boolean) 语义）；
    // 传输两键经 transportFields 同一三态构造（patch 目标：跟随系统发 httpProxy:null 显式
    // unset——省键=服务端不改动，承载不了"还原跟随系统"）
    await api.updateRepo(editingId.value, {
      pollIntervalSeconds: Number(String(editInterval.value).trim()),
      defaultBranch: editBranch.value.trim(),
      branchExclude: editExclude.value.split(',').map(s => s.trim()).filter(Boolean),
      ...transportFields(editBypass.value, editProxyMode.value, editProxy.value, 'patch')
    })
    editingId.value = ''
    error.value = ''
    await refresh()
  } catch (e) {
    // 失败留在编辑态（横幅透出服务端 message），可改后重试或取消
    error.value = (e as Error).message
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
      <!-- v1.4 网络连接方式（原"传输（高级）"改名，用户反馈旧命名不可理解）：
           代理三态下拉（跟随系统 git 配置/强制直连（无代理）/通过代理服务器连接）+
           "绕过系统 git 配置"独立 checkbox（与代理三态正交，不再是直连的隐含条件）。
           载荷（POST：system 省键 / PATCH：system 发 httpProxy:null 显式 unset）/
           none httpProxy:'' / custom httpProxy:<输入值>（输入框仅 custom 态显现） -->
      <div class="transport-group">
        <span class="transport-title">网络连接方式</span>
        <label class="inline-check">
          <input type="checkbox" class="add-bypass" v-model="formBypass" /> 绕过系统 git 配置（直连外部仓库）
        </label>
        <label class="proxy-mode-row">
          代理
          <select class="add-proxy-mode" v-model="formProxyMode" title="代理三态：跟随系统 git 配置 / 强制直连（无代理）/ 通过代理服务器连接">
            <option value="system">跟随系统 git 配置</option>
            <option value="none">强制直连（无代理）</option>
            <option value="custom">通过代理服务器连接</option>
          </select>
        </label>
        <input
          v-if="formProxyMode === 'custom'" class="add-proxy" v-model="formProxy"
          title="显式代理地址，如 http://127.0.0.1:8080"
          placeholder="http://…"
        />
      </div>
      <button class="btn" type="submit">添加</button>
    </form>

    <table class="tbl">
      <thead>
        <tr><th>id</th><th>url</th><th>默认分支</th><th>轮询间隔</th><th>排除 glob</th><th>传输</th><th>调度状态</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in repos" :key="r.id">
          <td><code>{{ r.id }}</code></td>
          <!-- url 身份键不可改：编辑态保持只读文本 + title 提示，绝不渲染输入框 -->
          <td class="url-cell" :title="editingId === r.id ? URL_IMMUTABLE_HINT : undefined">{{ r.url }}</td>
          <td v-if="editingId === r.id"><input class="edit-branch" v-model="editBranch" @keyup.enter="onSave" /></td>
          <td v-else>{{ r.defaultBranch }}</td>
          <td v-if="editingId === r.id"><input class="edit-interval" v-model="editInterval" type="number" min="5" step="1" @keyup.enter="onSave" /></td>
          <td v-else>{{ r.pollIntervalSeconds }}s</td>
          <td v-if="editingId === r.id"><input class="edit-exclude" v-model="editExclude" @keyup.enter="onSave" /></td>
          <td v-else class="muted">{{ r.branchExclude?.join(',') || '—' }}</td>
          <!-- v1.4 网络连接方式列：编辑态就地给绕过 checkbox + 代理三态下拉（输入框仅 custom 态）；
               展示态四态（直连=绕过/代理=非空/无代理=''/—=省键跟随系统）。
               读取经 bypassOf/proxyModeOf 兜底——GET 行 httpProxy 未设省键不误渲染 -->
          <td class="transport-cell">
            <template v-if="editingId === r.id">
              <label class="inline-check" title="绕过系统 git 配置（直连外部仓库）">
                <input type="checkbox" class="edit-bypass" v-model="editBypass" /> 绕过配置
              </label>
              <select class="edit-proxy-mode" v-model="editProxyMode" title="代理三态">
                <option value="system">跟随系统</option>
                <option value="none">强制直连</option>
                <option value="custom">自定义代理</option>
              </select>
              <input v-if="editProxyMode === 'custom'" class="edit-proxy" v-model="editProxy" placeholder="http://…" />
            </template>
            <template v-else>
              <span v-if="bypassOf(r)" class="badge badge-blue" title="绕过系统 git 配置">直连</span>
              <span v-else-if="proxyOf(r)" class="badge badge-yellow" :title="proxyOf(r)">代理</span>
              <span v-else-if="'httpProxy' in r" class="muted" title="httpProxy 显式置空：强制无代理">无代理</span>
              <span v-else class="muted" title="未显式设置：跟随系统 git 配置">—</span>
            </template>
          </td>
          <td><span class="badge" :class="badge(r).cls">{{ badge(r).text }}</span></td>
          <td>
            <template v-if="editingId === r.id">
              <button class="btn" @click="onSave">保存</button>
              <button class="btn" @click="cancelEdit">取消</button>
            </template>
            <template v-else>
              <button class="btn" @click="startEdit(r)">编辑</button>
              <button class="btn" @click="onRemove(r.id)">删除</button>
            </template>
          </td>
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
/* 行内编辑输入与添加表单同视觉语言；url 列编辑态保持只读文本（灰化以示不可改） */
.tbl input { padding: 2px 8px; border-radius: 6px; border: 1px solid #d0d7de; width: 140px; }
.url-cell { color: #656d76; }
/* v1.4 网络连接方式区：与表单 label 同列布局语言；代理三态下拉 + 仅 custom 态显现的代理输入 */
.transport-group { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.transport-title { font-weight: 600; }
.inline-check { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.inline-check input { min-width: 0; }
.proxy-mode-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.transport-group select { padding: 4px 8px; border-radius: 6px; border: 1px solid #d0d7de; }
.add-proxy { padding: 4px 8px; border-radius: 6px; border: 1px solid #d0d7de; min-width: 280px; }
.transport-cell { white-space: nowrap; }
.transport-cell select { padding: 2px 8px; border-radius: 6px; border: 1px solid #d0d7de; }
.transport-cell .edit-proxy { width: 120px; }
/* 深色模式：style.css 不在本任务修改清单内，scoped 就近补齐（与 .pick select 暗色语言同源，
   防浅底继承浅字不可读——v1.3.2 表单控件对比度修复的同类问题） */
@media (prefers-color-scheme: dark) {
  .transport-group select, .transport-cell select {
    background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
  }
  .transport-group select:focus, .transport-cell select:focus { border-color: #58a6ff; }
}
</style>
