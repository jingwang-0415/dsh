import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { diffRefs } from '../src/refDiff.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyChange } from '../src/refDiff.js'
import { spawnSync } from 'node:child_process'

describe('diffRefs 纯函数', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)

  it('新分支', () => {
    expect(diffRefs({}, { master: A })).toEqual([{ type: 'added', branch: 'master', newSha: A }])
  })
  it('更新', () => {
    expect(diffRefs({ master: A }, { master: B })).toEqual([{ type: 'updated', branch: 'master', oldSha: A, newSha: B }])
  })
  it('删除', () => {
    expect(diffRefs({ side: A }, {})).toEqual([{ type: 'deleted', branch: 'side', oldSha: A }])
  })
  it('无变化', () => {
    expect(diffRefs({ master: A }, { master: A })).toEqual([])
  })
})

describe('classifyChange（真实 git）', () => {
  it('后代提交判为 fast-forward', async () => {
    const origin = createOriginRepo()
    const oldSha = origin.commitFile('a.txt', '1')
    const newSha = origin.commitFile('b.txt', '2')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const c = await classifyChange(mirrorDir, { type: 'updated', branch: 'master', oldSha, newSha })
    expect(c).toEqual({ type: 'fast-forward', branch: 'master', oldSha, newSha })
  })

  it('历史重写判为 force-push', async () => {
    const origin = createOriginRepo()
    const oldSha = origin.commitFile('a.txt', '1')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    // 固定 author 日期：同秒内 amend 且无变更会产生完全相同的提交对象（SHA 不变），导致历史重写未发生
    origin.git(['commit', '--amend', '--no-edit', '--allow-empty', '--date=2005-04-07T22:13:13 +0000'])  // 镜像克隆后重写历史
    const amended = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: origin.dir, encoding: 'utf8' }).stdout.trim()
    const c = await classifyChange(mirrorDir, { type: 'updated', branch: 'master', oldSha, newSha: amended })
    expect(c).toEqual({ type: 'force-push', branch: 'master', oldSha, newSha: amended })
  })
})
