import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'

afterEach(cleanupTracked)
import { ensureMirror } from '../src/mirror.js'
import { crossCompare, mergePatchMaps, showCommits } from '../src/crossrepo.js'
import type { Fingerprint } from '../src/patchid.js'

const f = (patchId: string, sha: string): Fingerprint => ({ patchId, sha })

describe('mergePatchMaps 纯函数', () => {
  it('交集/单向/空集', () => {
    const r = mergePatchMaps([f('p1', 'a1'), f('p2', 'a2')], [f('p2', 'b2'), f('p3', 'b3')])
    expect(r.matched).toEqual([{ patchId: 'p2', shaA: 'a2', shaB: 'b2' }])
    expect(r.onlyInA.map(x => x.sha)).toEqual(['a1'])
    expect(r.onlyInB.map(x => x.sha)).toEqual(['b3'])
    expect(mergePatchMaps([], []).matched).toEqual([])
  })
})

describe('crossCompare（真实 git 独立双仓）', () => {
  it('同补丁跨仓命中 matched；单向补丁入 onlyIn', async () => {
    const a = createOriginRepo('gsm-ca-')
    const b = createOriginRepo('gsm-cb-')
    // 区分提交规避同秒初始提交字节级相同（仓库既定经验）；b-base.txt 补丁仅存在于 B
    a.commitFile('a-base.txt', 'a\n')
    const shaBaseB = b.commitFile('b-base.txt', 'b\n')
    a.git(['checkout', '-b', 'dev'])
    const shaSameA = a.commitFile('same.txt', 'identical patch\n')
    const shaOnlyA = a.commitFile('only-a.txt', 'only a\n')
    b.git(['checkout', '-b', 'dev'])
    const shaSameB = b.commitFile('same.txt', 'identical patch\n')

    const ma = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-ca-m-'))), 'm.git')
    const mb = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-cb-m-'))), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)

    const r = await crossCompare(ma, 'dev', mb, 'dev', [], [])
    expect(r.matchedPairs.map(p => [p.shaA, p.shaB])).toContainEqual([shaSameA, shaSameB])
    expect(r.onlyInA.map(c => c.sha)).toContain(shaOnlyA)
    // 简报实证修正：b-base.txt 补丁仅在 B，真实归并必入 onlyInB；README/same 补丁双方一致 → matched
    expect(r.onlyInB.map(c => c.sha)).toEqual([shaBaseB])
    // A: README+a-base+same+only-a=4；B: README+b-base+same=3；matched: README+same=2
    expect(r.stats).toEqual({ aTotal: 4, bTotal: 3, matched: 2, onlyA: 2, onlyB: 1 })
    expect(r.onlyInA.find(c => c.sha === shaOnlyA)!.subject).toBe('add only-a.txt')
  })

  it('exclude 过滤：仅 vendor 改动的提交不进指纹', async () => {
    const a = createOriginRepo('gsm-cc-')
    const b = createOriginRepo('gsm-cc2-')
    a.git(['checkout', '-b', 'dev'])
    // fixture commitFile 为裸 writeFileSync，子目录需先创建（探针实证：ENOENT）
    mkdirSync(join(a.dir, 'vendor'), { recursive: true })
    a.commitFile('vendor/lib.js', 'x')
    const ma = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-cc-m-'))), 'm.git')
    const mb = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-cc2-m-'))), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)
    const r = await crossCompare(ma, 'dev', mb, 'master', [], ['vendor/**'])
    expect(r.onlyInA).toHaveLength(0) // vendor 改动被排除，A 无其他独有补丁
  })
})

describe('showCommits 分批（真实 git）', () => {
  it('201 个 sha（跨 SHOW_BATCH=200 边界）：输入顺序完整拼接不丢不重', async () => {
    const origin = createOriginRepo('gsm-cb-')
    // fast-import 单进程构造 201 个提交（探针实证：逐个 commit 约 26ms×201 会超 vitest 默认 5s）
    const lines = ['commit refs/heads/batch', 'mark :1', 'committer T <t@e.c> 1700000000 +0000', 'data 4', 'root', '']
    for (let i = 1; i <= 201; i++) {
      lines.push('commit refs/heads/batch', `mark :${i + 1}`, 'committer T <t@e.c> 1700000000 +0000', 'data 4', `t${String(i).padStart(3, '0')}`, `from :${i}`, '')
    }
    const fi = spawnSync('git', ['fast-import', '--quiet'], { cwd: origin.dir, input: lines.join('\n'), encoding: 'utf8' })
    expect(fi.status).toBe(0)
    const revList = spawnSync('git', ['rev-list', 'refs/heads/batch'], { cwd: origin.dir, encoding: 'utf8' })
    const all = revList.stdout.trim().split('\n')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-cb-m-'))), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    // 乱序输入（非提交序）→ 断言结果与输入数组完全一致（分批拼接保持输入顺序）
    const shas = all.slice(0, 201).reverse()
    const result = await showCommits(mirrorDir, shas)
    expect(result.map(c => c.sha)).toEqual(shas)
    expect(result).toHaveLength(201)
    expect(new Set(result.map(c => c.sha)).size).toBe(201)
    expect(result.find(c => c.subject === 't201')).toBeTruthy()
  })
})
