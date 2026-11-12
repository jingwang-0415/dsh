import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { matchesGlob } from './util/glob.js'

// 导出：POST /api/repos 复用同一校验契约（单仓校验不等同于整体 configSchema）。
// id 白名单 ^[A-Za-z0-9._-]+$：id 同时是 mirror 目录名/API ?repo= 取值，
// `../demo` 这类值会逃出 repos/ 根目录，必须在此源头封死。
// 注意白名单正则会放行 '.' 与 '..'（审查 C1）：mirrorDirFor('..') = join(dataDir,'repos','..')
// = dataDir 本身 → ensureMirror 见目录存在报 corrupt → rmSync 递归强删 = 清掉整个数据目录，
// 故需 refine 显式拒绝
// 上界 604800 = 7 天：Node 对 delay > 2^31-1ms 的 setTimeout 钳为 1ms，
// pollIntervalSeconds ≥2,147,484 秒（约 24.85 天）会让调度器变成"每轮 fetch 完
// 立刻 1ms 重排"的连续 fetch 循环打爆远端；api.ts PATCH 手写校验共享此常量
export const MAX_POLL_INTERVAL_SECONDS = 604800

export const repoSchema = z.object({
  id: z.string()
    .regex(/^[A-Za-z0-9._-]+$/, 'id 仅允许字母数字与 . _ -')
    .refine(id => id !== '.' && id !== '..', { message: 'id 不能为 . 或 ..' }),
  url: z.string().min(1),
  defaultBranch: z.string().min(1).default('master'),
  branchExclude: z.array(z.string()).default([]),
  pollIntervalSeconds: z.number().int().min(5).max(MAX_POLL_INTERVAL_SECONDS, '轮询间隔上限 604800 秒（7 天）').default(30),
  // 按仓传输兜底（v1.3.2，fix round 1 三分支语义）：
  // - bypassGitConfig 缺省 false（opt-in，不兜底）
  // - httpProxy 缺省 undefined = 跟随系统/全局 git 配置（不注入任何 -c 代理参数，
  //   存量仓行为逐字节不变）；'' = 显式强制无代理；非空 = 显式代理覆盖。
  //   未设与显式空串必须区分：default('') 会让存量仓被静默强制无代理
  //   （-c http.proxy= 同时压制全局配置代理与 env 代理，依赖内网代理的仓升级即断连）
  bypassGitConfig: z.boolean().default(false),
  httpProxy: z.string().optional(),
  // 按仓指定 git 配置档案（v1.5）：缺省 undefined = 使用机器级全局配置（存量行为不变）；
  // 与 bypassGitConfig 互斥（下方 schema 级 refine 挡）——bypass 清空全部配置档案，
  // 再指定档案属语义矛盾；文件存在性由 api 层 existsSync 校验（config 层不做 IO）；
  // min(1) 空串收口：'' 在此 400 invalid，不落 api 层 existsSync('') 的"空路径不存在"文案
  gitConfigPath: z.string().min(1).optional()
})
// schema 级 refine：双设即拒（loadConfig 启动挡 + POST safeParse 400 invalid 透传）。
// refine 在 default 填充后运行，data.bypassGitConfig 恒为 boolean；
// 消息含"互斥"（测试与 400 message 断言锚点）
  .refine(
    data => !(data.bypassGitConfig && data.gitConfigPath),
    { message: 'bypassGitConfig 与 gitConfigPath 互斥' }
  )

const configSchema = z.object({
  // repo id 同时是 mirror 目录名/调度器标识/API ?repo= 取值，重复会让三方引用全部歧义
  repos: z
    .array(repoSchema)
    .min(1)
    .refine(repos => new Set(repos.map(r => r.id)).size === repos.length, { message: 'repo id 必须唯一' }),
  server: z
    .object({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).default(43900) })
    .default({})
})

export type RepoConfig = z.infer<typeof repoSchema>
export type AppConfig = z.infer<typeof configSchema>

export function loadConfig(path: string): AppConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`无法读取配置文件 ${path}: ${(e as Error).message}`)
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`配置不合法: ${detail}`)
  }
  return parsed.data
}

/**
 * 原子回写 config.json：同目录 tmp 文件 + renameSync（同文件系统 rename 原子），
 * 进程中途被杀也不会留下半截 config.json；tmp 落在目标目录内保证同分区。
 * mkdir recursive：首次运行（默认路径目录尚不存在）与 configOverride 场景也能落盘。
 */
export function writeConfig(path: string, cfg: AppConfig): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.gsm-config-${process.pid}-${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n')
  try {
    renameSync(tmp, path)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    throw e
  }
}

export function isBranchExcluded(branch: string, patterns: string[]): boolean {
  return patterns.some(p => matchesGlob(branch, p))
}

/**
 * 原位变更 repo 的可 PATCH 字段（仅赋提供的键，undefined 的键不写入）。
 * **禁止整体替换对象**：app.ts 装配时把 config.repos 中的仓对象直接传给
 * Scheduler({ repo })，deps.repo 与 config.repos 中的对象是同一引用；本函数用
 * Object.assign 只改字段、不换对象，PATCH 后下一轮询周期即按新值调度。
 * 若调用方用 splice/新对象替换，调度器仍持旧对象，运行时调整会静默失效。
 * 值校验由调用方完成（api.ts PATCH 端点），这里只做字段级赋值。
 * httpProxy null 分支（JSON Merge Patch 风格显式 unset）：delete 摘除字段回到
 * "跟随系统 git 配置"，config.json 回写时 undefined 键自然省略（JSON.stringify 行为）；
 * gitConfigPath null 分支同构（v1.5：回到"使用机器级全局配置"）；
 * RepoConfig.httpProxy/gitConfigPath 为 optional，delete 合法且不破坏原对象引用。
 * 互斥（bypassGitConfig && gitConfigPath 不同真）由调用方（api.ts PATCH）前置校验，
 * 本函数只做字段级赋值不拦组合——直调方须自行保证生效态合法。
 */
export function updateRepoFields(
  repo: RepoConfig,
  patch: {
    pollIntervalSeconds?: number; defaultBranch?: string; branchExclude?: string[]
    bypassGitConfig?: boolean; httpProxy?: string | null; gitConfigPath?: string | null
  }
): void {
  Object.assign(repo, {
    ...(patch.pollIntervalSeconds !== undefined && { pollIntervalSeconds: patch.pollIntervalSeconds }),
    ...(patch.defaultBranch !== undefined && { defaultBranch: patch.defaultBranch }),
    ...(patch.branchExclude !== undefined && { branchExclude: patch.branchExclude }),
    ...(patch.bypassGitConfig !== undefined && { bypassGitConfig: patch.bypassGitConfig }),
    ...(typeof patch.httpProxy === 'string' && { httpProxy: patch.httpProxy }),
    ...(typeof patch.gitConfigPath === 'string' && { gitConfigPath: patch.gitConfigPath })
  })
  // 显式 null = unset（null 不是 undefined，二者语义必须区分：缺省不动 / null 删字段）
  if (patch.httpProxy === null) delete repo.httpProxy
  if (patch.gitConfigPath === null) delete repo.gitConfigPath
}
