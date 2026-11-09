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
  httpProxy: z.string().optional()
})

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
 */
export function updateRepoFields(
  repo: RepoConfig,
  patch: {
    pollIntervalSeconds?: number; defaultBranch?: string; branchExclude?: string[]
    bypassGitConfig?: boolean; httpProxy?: string
  }
): void {
  Object.assign(repo, {
    ...(patch.pollIntervalSeconds !== undefined && { pollIntervalSeconds: patch.pollIntervalSeconds }),
    ...(patch.defaultBranch !== undefined && { defaultBranch: patch.defaultBranch }),
    ...(patch.branchExclude !== undefined && { branchExclude: patch.branchExclude }),
    ...(patch.bypassGitConfig !== undefined && { bypassGitConfig: patch.bypassGitConfig }),
    ...(patch.httpProxy !== undefined && { httpProxy: patch.httpProxy })
  })
}
