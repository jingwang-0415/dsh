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
