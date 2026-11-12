import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runGit } from './gitRunner.js'

export type RefSnapshot = { [branch: string]: string }

/**
 * 按仓传输兜底（v1.3.2 Task 1，fix round 1 三分支语义；v1.5 增 gitConfigPath）：
 * - bypassGitConfig：绕过系统/全局 git 配置直连（spawn env GIT_CONFIG_GLOBAL/SYSTEM=/dev/null），
 *   解决"内源代理劫持 git 全局配置导致 clone 只达内网"的场景。
 *   ⚠ 凭据面副作用：全局/系统配置一并被清空 → credential.helper 随之失效，
 *   依赖存储凭据的私有 https 仓在 bypass 下认证会失败（需匿名可达或令牌内嵌 URL）。
 * - gitConfigPath：按仓指定 git 配置档案（spawn env GIT_CONFIG_GLOBAL=<path>），
 *   GIT_CONFIG_SYSTEM 不注入——机器级配置继续生效；与 bypassGitConfig 互斥
 *   （config 层 refine 挡，mirror 层 defensive：bypass 优先）。
 * - httpProxy 三分支：undefined = 跟随系统/全局 git 配置（不注入任何代理参数，存量仓行为不变）；
 *   '' = 显式强制无代理（探针实证 git 2.50.1：`-c http.proxy=` 覆盖全局配置恢复直连）；
 *   非空 = 显式代理覆盖。与 bypassGitConfig/gitConfigPath 可组合（args 与 env 正交）。
 */
export type TransportOpts = { bypassGitConfig?: boolean; httpProxy?: string; gitConfigPath?: string }

/** 纯函数：httpProxy undefined → []（不注入代理参数，bypass 亦不产生 args——走 env）；'' → 空 -c 对；非空 → 带值 -c 对 */
export function transportArgs(opts: TransportOpts): string[] {
  if (opts.httpProxy === undefined) return []
  return ['-c', `http.proxy=${opts.httpProxy}`, '-c', `https.proxy=${opts.httpProxy}`]
}

// bypass 走 env 而非 args：git 无法用 -c 关闭"读取配置文件"本身，/dev/null 是官方等价手法
const BYPASS_GIT_CONFIG_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

/**
 * 纯函数：transport → git spawn env 覆盖（v1.5 env 三分支，便于测试与调用方按空判断）：
 * - bypassGitConfig → GLOBAL/SYSTEM 均 /dev/null（v1.3.2 语义；defensive 优先——
 *   schema refine 已禁双设，此处仍以 bypass 为先，绝不出现"bypass 下读指定档案"）
 * - 否则 gitConfigPath → 仅 GIT_CONFIG_GLOBAL=<path>（SYSTEM 键不出现，机器级配置保留）
 * - 均未设 → {}（调用方按空判断不加 env 键，spawn 行为与未传时逐字节一致）
 * httpProxy 不进 env（走 transportArgs 的 -c 前缀）；runGit 按 {...process.env, ...env}
 * 覆盖合并，指定档案可压过继承的 GIT_CONFIG_GLOBAL（劫持覆盖用例实证）。
 */
export function transportOptsEnv(opts: TransportOpts): Record<string, string> {
  if (opts.bypassGitConfig) return BYPASS_GIT_CONFIG_ENV
  if (opts.gitConfigPath !== undefined) return { GIT_CONFIG_GLOBAL: opts.gitConfigPath }
  return {}
}

export async function ensureMirror(url: string, dir: string, transport?: TransportOpts): Promise<'cloned' | 'existing'> {
  if (existsSync(dir)) return 'existing'
  mkdirSync(dirname(dir), { recursive: true })
  const env = transportOptsEnv(transport ?? {})
  await runGit(
    process.cwd(),
    [...transportArgs(transport ?? {}), 'clone', '--mirror', url, dir],
    Object.keys(env).length > 0 ? { env } : {}
  )
  return 'cloned'
}

export async function fetchMirror(dir: string, transport?: TransportOpts): Promise<void> {
  const env = transportOptsEnv(transport ?? {})
  await runGit(
    dir,
    [...transportArgs(transport ?? {}), 'fetch', '--prune', 'origin'],
    Object.keys(env).length > 0 ? { env } : {}
  )
}

export async function snapshotRefs(dir: string): Promise<RefSnapshot> {
  const { stdout } = await runGit(dir, [
    'for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)'
  ])
  const snap: RefSnapshot = {}
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    snap[line.slice(0, tab)] = line.slice(tab + 1)
  }
  return snap
}
