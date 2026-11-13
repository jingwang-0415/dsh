<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
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
// v1.5 按仓指定 git 配置档案（可选）：空 = 使用机器级全局配置（POST 省键/PATCH 发 null unset）
const formGitConfig = ref('')

// 代理三态载荷构造（v1.4，POST 与 PATCH 共用同一构造；契约见 server repoSchema/PATCH：
// undefined=跟随系统 git 配置、''=强制无代理、非空=显式代理）：
// - bypassGitConfig 恒带 boolean（"是否绕过系统 git 配置"独立开关，与代理三态正交）
// - custom → httpProxy:<输入值>；none → httpProxy:''
// - system 态按目标分：PATCH → httpProxy:null（JSON Merge Patch 显式 unset，服务端删字段，
//   已设代理的仓可经 UI 还原为跟随系统；省键会被服务端理解为"不改动"，承载不了该语义）；
//   POST → 省键（新建即跟随系统）。custom 且输入为空被 validate 先行拦截，此处兜底按目标
//   语义处理：patch → httpProxy:null（显式 unset）、post → 省键——绝不静默降级成另一态
// v1.5 gitConfigPath 同构造（与代理/env 正交，可组合）：
// - 非空（trim 后）→ gitConfigPath:<值>；bypass 为真时联动已清空，此处兜底按空处理（互斥先拦）
// - 空 + POST → 省键（undefined，T1 语义：新建未指定 = 使用机器级全局配置）
// - 空 + PATCH → null（显式 unset）：省键=服务端"不改动"，既清不掉存量路径，也会让
//   "存量路径 + PATCH bypass:true"撞服务端生效态互斥 400——单次保存切换必须显式 null
function transportFields(bypass: boolean, mode: ProxyMode, proxyRaw: string, gitPathRaw: string, target: 'post' | 'patch'): { bypassGitConfig: boolean; httpProxy?: string | null; gitConfigPath?: string | null } {
  const proxy = proxyRaw.trim()
  const proxyField: { httpProxy?: string | null } =
    mode === 'custom' && proxy ? { httpProxy: proxy }
      : mode === 'none' ? { httpProxy: '' }
        : target === 'patch' ? { httpProxy: null }
          : {}
  const gitPath = bypass ? '' : gitPathRaw.trim()
  const gitConfigField: { gitConfigPath?: string | null } =
    gitPath ? { gitConfigPath: gitPath }
      : target === 'patch' ? { gitConfigPath: null }
        : {}
  return { bypassGitConfig: bypass, ...proxyField, ...gitConfigField }
}

// T1 裁定：GET 行 httpProxy 未设省键（DTO optional）——读取一律经此兜底，
// 表格标记与编辑预填共用，键省略时不误渲染"代理"/不误预填
const bypassOf = (r: RepoDto): boolean => r.bypassGitConfig ?? false
const proxyOf = (r: RepoDto): string => ('httpProxy' in r ? (r.httpProxy ?? '') : '')
// v1.5 同款兜底：gitConfigPath 未设省键（undefined=使用机器级全局配置）
const gitCfgOf = (r: RepoDto): string => r.gitConfigPath ?? ''
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
  Object.assign(body, transportFields(formBypass.value, formProxyMode.value, formProxy.value, formGitConfig.value, 'post'))
  try {
    await api.addRepo(body)
    formId.value = ''; formUrl.value = ''; formBranch.value = ''; formInterval.value = ''; formExclude.value = ''
    formBypass.value = false; formProxyMode.value = 'system'; formProxy.value = ''; formGitConfig.value = ''
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}

// v1.6 EP 迁移：删除确认改 el-popconfirm（@confirm 进来；替代原 window.confirm stub 门），
// 删除语义与 server 一致：停调度 + 移出 config.json；DB 历史保留，同 id 重挂自动接续
async function onRemove(id: string): Promise<void> {
  try {
    await api.removeRepo(id)
    error.value = ''
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}

// v1.6 EP 迁移：调度状态徽标 badge.cls → el-tag type（success=监听中 / info=空闲·未知 /
// warning=重试中 / primary=启动中），文案四分支逐字保留
function badge(r: RepoDto): { type: 'success' | 'info' | 'warning' | 'primary'; text: string } {
  const s = statuses.value[r.id]
  if (!s) return { type: 'info', text: '未知' }
  switch (s.state) {
    case 'running': return { type: 'success', text: '监听中' }
    case 'idle': return { type: 'info', text: '空闲' }
    case 'backoff': return { type: 'warning', text: '重试中' }
    case 'starting': return { type: 'primary', text: '启动中' }
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
// v1.5 行内编辑态的 git 配置档案输入（startEdit 预填当前行值，空 = 机器级全局配置）
const editGitConfig = ref('')
const URL_IMMUTABLE_HINT = 'url 不可修改，更换地址请删除后重新添加'

// 互斥联动（服务端 400 mutually_exclusive 的前端先拦）：勾直连 → 清空并禁用 gitConfigPath
// 输入（:disabled 绑定）；反向在模板绑——填了路径 → 直连 checkbox 禁用（添加表单与行内编辑同构）
watch(formBypass, on => { if (on) formGitConfig.value = '' })
watch(editBypass, on => { if (on) editGitConfig.value = '' })

function startEdit(r: RepoDto): void {
  editingId.value = r.id
  editBranch.value = r.defaultBranch
  editInterval.value = String(r.pollIntervalSeconds)
  editExclude.value = (r.branchExclude ?? []).join(',')
  editBypass.value = bypassOf(r)
  editProxyMode.value = proxyModeOf(r)
  editProxy.value = proxyOf(r)
  editGitConfig.value = gitCfgOf(r)   // v1.5 预填（未设省键 → ''）
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
    // 传输键经 transportFields 同一构造（patch 目标：跟随系统发 httpProxy:null 显式 unset——
    // 省键=服务端不改动，承载不了"还原跟随系统"；gitConfigPath 空输入发 null unset，
    // 既有路径可清、"存量路径 → 直连"单次保存可达——省键会撞服务端生效态互斥 400）
    await api.updateRepo(editingId.value, {
      pollIntervalSeconds: Number(String(editInterval.value).trim()),
      defaultBranch: editBranch.value.trim(),
      branchExclude: editExclude.value.split(',').map(s => s.trim()).filter(Boolean),
      ...transportFields(editBypass.value, editProxyMode.value, editProxy.value, editGitConfig.value, 'patch')
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
    <el-alert v-if="error" class="error-alert" type="error" :title="error" :closable="false" />

    <el-form class="add-form" @submit.prevent="onAdd">
      <el-form-item label="id"><el-input v-model="formId" placeholder="repo-id" /></el-form-item>
      <el-form-item label="url"><el-input v-model="formUrl" placeholder="https://example.com/beta.git" /></el-form-item>
      <el-form-item label="默认分支"><el-input v-model="formBranch" placeholder="master" /></el-form-item>
      <el-form-item label="轮询间隔秒"><el-input v-model="formInterval" placeholder="30" /></el-form-item>
      <el-form-item label="排除 glob"><el-input v-model="formExclude" placeholder="vendor/**,docs/**" /></el-form-item>
      <!-- v1.4 网络连接方式（原"传输（高级）"改名，用户反馈旧命名不可理解）：
           代理三态下拉（跟随系统 git 配置/强制直连（无代理）/通过代理服务器连接）+
           "绕过系统 git 配置"独立 checkbox（与代理三态正交，不再是直连的隐含条件）。
           载荷（POST：system 省键 / PATCH：system 发 httpProxy:null 显式 unset）/
           none httpProxy:'' / custom httpProxy:<输入值>（输入框仅 custom 态显现） -->
      <div class="transport-group">
        <span class="transport-title">网络连接方式</span>
        <el-checkbox
          class="add-bypass" v-model="formBypass" :disabled="formGitConfig.trim() !== ''"
          title="勾选后，拉取代码时忽略本机 git 全局配置（含代理与凭据助手），直接连接目标仓库。适用于本机 git 配置了代理/改写导致外部仓库不可达的场景；注意私有仓库的存储凭据在此模式下失效"
        >忽略本机 git 配置直连</el-checkbox>
        <div class="proxy-mode-row">
          <span>代理</span>
          <el-select
            class="add-proxy-mode" v-model="formProxyMode" :teleported="false"
            title="代理三态：跟随本机 git 配置 / 不走代理（强制无代理）/ 通过指定代理服务器连接"
          >
            <el-option label="跟随本机 git 配置" value="system" />
            <el-option label="不走代理（强制无代理）" value="none" />
            <el-option label="通过指定代理服务器连接" value="custom" />
          </el-select>
        </div>
        <el-input
          v-if="formProxyMode === 'custom'" class="add-proxy" v-model="formProxy"
          title="显式代理地址，如 http://127.0.0.1:8080"
          placeholder="http://…"
        />
        <!-- v1.5 按仓指定 git 配置档案（可选，与代理/env 正交可组合）：
             与直连互斥——勾直连清空并禁用本输入，填了路径则禁用直连 checkbox -->
        <div class="gitcfg-row">
          <span>自定义 git 配置文件（可选）</span>
          <el-input
            class="add-gitcfg" v-model="formGitConfig" :disabled="formBypass"
            title="以该文件作为本仓 git 全局配置（GIT_CONFIG_GLOBAL）；与直连互斥"
            placeholder="/path/to/git-config"
          />
        </div>
      </div>
      <el-button type="primary" native-type="submit">添加</el-button>
    </el-form>

    <el-table :data="repos">
      <el-table-column label="id">
        <template #default="{ row }"><code>{{ row.id }}</code></template>
      </el-table-column>
      <!-- url 身份键不可改：编辑态保持只读文本 + title 提示，绝不渲染输入框 -->
      <el-table-column label="url" class-name="url-cell" min-width="220">
        <template #default="{ row }">
          <span class="url-text" :title="editingId === row.id ? URL_IMMUTABLE_HINT : undefined">{{ row.url }}</span>
        </template>
      </el-table-column>
      <el-table-column label="默认分支" min-width="150">
        <template #default="{ row }">
          <el-input v-if="editingId === row.id" v-model="editBranch" class="edit-branch" @keyup.enter="onSave" />
          <template v-else>{{ row.defaultBranch }}</template>
        </template>
      </el-table-column>
      <el-table-column label="轮询间隔" min-width="130">
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id" v-model="editInterval" class="edit-interval"
            type="number" min="5" step="1" @keyup.enter="onSave"
          />
          <template v-else>{{ row.pollIntervalSeconds }}s</template>
        </template>
      </el-table-column>
      <el-table-column label="排除 glob" min-width="150">
        <template #default="{ row }">
          <el-input v-if="editingId === row.id" v-model="editExclude" class="edit-exclude" @keyup.enter="onSave" />
          <span v-else class="muted">{{ row.branchExclude?.join(',') || '—' }}</span>
        </template>
      </el-table-column>
      <!-- v1.4 网络连接方式列：编辑态就地给绕过 checkbox + 代理三态下拉（输入框仅 custom 态）；
           展示态四态（直连=绕过/代理=非空/无代理=''/—=省键跟随系统）。
           读取经 bypassOf/proxyModeOf 兜底——GET 行 httpProxy 未设省键不误渲染 -->
      <el-table-column label="传输" class-name="transport-cell" min-width="280">
        <template #default="{ row }">
          <template v-if="editingId === row.id">
            <el-checkbox
              class="edit-bypass" v-model="editBypass" :disabled="editGitConfig.trim() !== ''"
              title="勾选后，拉取代码时忽略本机 git 全局配置（含代理与凭据助手），直接连接目标仓库"
            >忽略配置</el-checkbox>
            <!-- v1.6-T2fix：teleported 保持默认（弹层 teleport 到 body）——表格 .cell 的
                 overflow:hidden 会裁剪落在 cell 内部的 absolute 弹层（三态下拉约 90px 高，
                 仅剩 23px 行高可见、基本不可见）；防回归锚见 Repos.test.ts「防回归锚」用例 -->
            <el-select
              class="edit-proxy-mode" v-model="editProxyMode"
              title="网络连接方式：跟随本机 git 配置 / 不走代理（强制无代理）/ 通过指定代理服务器连接"
            >
              <el-option label="跟随本机配置" value="system" />
              <el-option label="不走代理" value="none" />
              <el-option label="指定代理" value="custom" />
            </el-select>
            <el-input v-if="editProxyMode === 'custom'" class="edit-proxy" v-model="editProxy" placeholder="http://…" />
            <!-- v1.5 git 配置档案输入：勾直连清空并禁用（watcher + :disabled） -->
            <el-input
              class="edit-gitcfg" v-model="editGitConfig" :disabled="editBypass"
              title="以该文件作为本仓 git 全局配置（GIT_CONFIG_GLOBAL）；与直连互斥"
              placeholder="/path/to/git-config"
            />
          </template>
          <template v-else>
            <el-tag v-if="bypassOf(row as RepoDto)" title="忽略本机 git 配置直连">直连</el-tag>
            <el-tag v-else-if="proxyOf(row as RepoDto)" type="warning" :title="proxyOf(row as RepoDto)">代理</el-tag>
            <span v-else-if="'httpProxy' in row" class="muted" title="httpProxy 显式置空：强制无代理">无代理</span>
            <span v-else class="muted" title="未显式设置：跟随本机 git 配置">—</span>
            <!-- v1.5 指定配置档案：与代理/直连状态正交（可组合），独立角标展示、title 携带路径 -->
            <el-tag v-if="gitCfgOf(row as RepoDto)" class="gitcfg-tag" type="info" effect="plain" :title="`自定义 git 配置文件: ${gitCfgOf(row as RepoDto)}`">档案</el-tag>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="调度状态">
        <template #default="{ row }">
          <el-tag :type="badge(row as RepoDto).type" effect="light">{{ badge(row as RepoDto).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="170">
        <template #default="{ row }">
          <template v-if="editingId === row.id">
            <el-button type="primary" size="small" @click="onSave">保存</el-button>
            <el-button size="small" @click="cancelEdit">取消</el-button>
          </template>
          <template v-else>
            <el-button size="small" @click="startEdit(row as RepoDto)">编辑</el-button>
            <!-- 删除确认：el-popconfirm 替代 window.confirm；确认文案保留原业务提示。
                 探针实证（zz-probe，临时不提交）：默认 action 按钮在本 jsdom/vitest 环境
                 （vite 管 element-plus + VTU transition 处理组合）下 @confirm 不触发——
                 改用 #actions 作用域插槽显式给取消/确定按钮（调用插槽 confirm/cancel），
                 全配置组合下稳定触发，且顺带锁定中文按钮文案（默认是英文 Yes/No）；
                 UI 与默认渲染等效 -->
            <el-popconfirm
              title="确定停止监控并移除该仓库？历史数据将保留"
              @confirm="onRemove((row as RepoDto).id)"
            >
              <template #reference>
                <el-button size="small" type="danger" plain>删除</el-button>
              </template>
              <template #actions="{ confirm, cancel }">
                <el-button size="small" class="pop-cancel" @click="cancel">取消</el-button>
                <el-button size="small" type="primary" class="pop-confirm" @click="confirm">确定</el-button>
              </template>
            </el-popconfirm>
          </template>
        </template>
      </el-table-column>
    </el-table>
    <p v-if="!repos.length" class="muted">暂无仓库——用上方表单添加第一个仓库。</p>
  </section>
</template>

<style scoped>
/* style.css 不在本任务修改清单内：表单布局以 scoped 规则就近提供（CrossRepo 先例）；
   v1.6 EP 迁移后控件视觉（边框/暗色）交由 EP 组件与 html.dark 变量体系，scoped 只管布局 */
.add-form { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: flex-start; margin-bottom: 16px; }
.add-form :deep(.el-form-item) { margin-bottom: 8px; }
.transport-group { display: flex; flex-direction: column; gap: 6px; font-size: 13px; padding-top: 4px; }
.transport-title { font-weight: 600; }
.proxy-mode-row, .gitcfg-row { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.add-proxy, .add-gitcfg { min-width: 280px; }
/* 行内编辑输入与添加表单同视觉语言；url 列编辑态保持只读文本（灰化以示不可改） */
.url-cell { color: #656d76; }
.transport-cell { white-space: nowrap; }
.transport-cell :deep(.el-input) { width: 130px; }
.transport-cell :deep(.el-select) { width: 120px; }
.transport-cell .gitcfg-tag { margin-left: 6px; }
</style>
