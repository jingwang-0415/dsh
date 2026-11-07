import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface OriginRepo {
  dir: string
  git(args: string[]): void
  commitFile(name: string, content: string): string
}

export function createOriginRepo(prefix = 'gsm-origin-'): OriginRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix))
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
