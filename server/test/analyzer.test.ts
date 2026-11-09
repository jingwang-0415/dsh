import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'

afterEach(cleanupTracked)
import { ensureMirror } from '../src/mirror.js'
import { aheadBehind, compareBranches, inclusionForCommit } from '../src/analyzer.js'
import { GitCommandError } from '../src/gitRunner.js'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}

describe('inclusionForCommit', () => {
  it('合并传播为包含；cherry-pick（不同 sha）判定为未包含（锁定 §3.3 语义）', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.git(['checkout', 'master'])
    const fixSha = origin.commitFile('fix.txt', 'fix')           // master 新提交
    origin.git(['checkout', 'release/1.0'])
    origin.git(['merge', 'master', '--no-edit'])                  // 合并 → 包含 fixSha
    origin.git(['checkout', 'master'])
    origin.commitFile('next.txt', 'n')                            // master 又前进
    origin.git(['checkout', '-b', 'cherry-side', 'master~2'])     // 基于 fixSha 之前的提交
    origin.git(['cherry-pick', fixSha])                           // cherry-pick → 新 sha
    // 固定 author 日期：同秒内 cherry-pick 到原父提交会产生与 fixSha 字节相同的提交对象（SHA 不变），
    // 语义前提"cherry-pick → 新 sha"就不成立；cherry-pick 保留原 author 日期且无 --date，借 amend 固定（先例：refDiff/sync 同秒修法）
    origin.git(['commit', '--amend', '--no-edit', '--date=2005-04-07T22:13:13 +0000'])
    origin.git(['checkout', 'master'])

    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)

    const branches = [
      { name: 'master', status: 'active' as const },
      { name: 'release/1.0', status: 'active' as const },
      { name: 'cherry-side', status: 'active' as const },
      { name: 'gone', status: 'deleted' as const }
    ]
    const results = await inclusionForCommit(mirrorDir, fixSha, branches)
    const byName = Object.fromEntries(results.map(r => [r.branch, r]))
    expect(byName['master']).toEqual({ branch: 'master', contains: true, status: 'active' })
    expect(byName['release/1.0'].contains).toBe(true)
    expect(byName['cherry-side'].contains).toBe(false)  // 核心语义：cherry-pick ≠ 包含
    expect(byName['gone']).toEqual({ branch: 'gone', contains: false, status: 'deleted' })
  })

  it('未知 sha 抛 GitCommandError', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const err = await inclusionForCommit(mirrorDir, 'f'.repeat(40), [{ name: 'master', status: 'active' }])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
  })
})

describe('aheadBehind / compareBranches', () => {
  it('ahead=base 独有，behind=target 独有', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'dev'])
    origin.commitFile('d1.txt', '1')
    origin.commitFile('d2.txt', '2')
    origin.git(['checkout', 'master'])
    origin.commitFile('m1.txt', '1')

    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-mirror-'))), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    expect(await aheadBehind(mirrorDir, 'dev', 'master')).toEqual({ ahead: 2, behind: 1 })

    const cmp = await compareBranches(mirrorDir, 'dev', 'master')
    expect(cmp.aheadCommits.map(c => c.subject).sort()).toEqual(['add d1.txt', 'add d2.txt'])
    expect(cmp.behindCommits.map(c => c.subject)).toEqual(['add m1.txt'])
    void headSha
  })
})
