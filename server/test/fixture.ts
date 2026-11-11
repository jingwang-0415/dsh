import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface OriginRepo {
  dir: string
  git(args: string[]): void
  commitFile(name: string, content: string): string
}

// 模块级注册表：本进程内所有测试临时目录，cleanupTracked 统一清理（vitest 按文件隔离 worker，无跨文件串扰）
const tmpDirs: string[] = []

/** 注册测试临时目录并原样返回 dir（便于内联包装 mkdtempSync），供 cleanupTracked 统一清理 */
export function trackTmp(dir: string): string {
  tmpDirs.push(dir)
  return dir
}

/** 递归强删全部注册目录并清空注册表；各测试文件在 afterEach / afterAll(handle.close 后) 调用 */
export function cleanupTracked(): void {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
}

export function createOriginRepo(prefix = 'gsm-origin-'): OriginRepo {
  const dir = trackTmp(mkdtempSync(join(tmpdir(), prefix)))
  const git = (args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} 失败: ${r.stderr}`)
  }
  git(['init', '--initial-branch=master'])
  git(['config', 'user.name', 'Tester'])
  git(['config', 'user.email', 'tester@example.com'])
  const commitFile = (name: string, content: string): string => {
    writeFileSync(join(dir, name), content)
    git(['add', name])
    git(['commit', '-m', `add ${name}`])
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  }
  commitFile('README.md', '# demo\n')
  return { dir, git, commitFile }
}

// —— 代理环境变量确定性（v1.4 最终修复批次）——
// runGit/mirror 系用例 spawn 真实 git 且继承本进程 env：导出 http(s)_proxy 且 no_proxy 未
// 豁免目标主机（如 127.0.0.1）的环境里，git 走代理转发而非直连，黑洞超时/劫持用例的预期
// 路径会被代理行为改写（如快速失败为 GitCommandError，复现不了超时）。清空代理 env 保证
// 跨环境确定性（no_proxy 等环境变量会遮蔽代理行为）。
const PROXY_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'no_proxy', 'NO_PROXY'
]

/** 清空代理环境变量执行 fn（子进程继承本进程 env；完成后原样恢复，原本未设的键不留痕） */
export async function withProxyEnvCleared(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const k of PROXY_ENV_KEYS) { saved.set(k, process.env[k]); delete process.env[k] }
  try { await fn() } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
