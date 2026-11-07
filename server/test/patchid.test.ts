import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror, fetchMirror } from '../src/mirror.js'
import { buildPathspecs, branchFingerprints, parsePatchIds } from '../src/patchid.js'
import { runGit } from '../src/gitRunner.js'

const runGitSync = (cwd: string, args: string[]): string =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout

describe('parsePatchIds', () => {
  it('解析 "id sha" 行并忽略空行', () => {
    expect(parsePatchIds('abc123 def456\n\n789aaa bbbccc\n')).toEqual([
      { patchId: 'abc123', sha: 'def456' },
      { patchId: '789aaa', sha: 'bbbccc' }
    ])
  })
})

describe('buildPathspecs', () => {
  it('include/exclude 编译为 git pathspec', () => {
    expect(buildPathspecs(['src/**'], ['vendor/**'])).toEqual([':(glob)src/**', ':(exclude,glob)vendor/**'])
    expect(buildPathspecs([], ['tmp/**'])).toEqual([':(exclude,glob)tmp/**'])
    expect(buildPathspecs([], [])).toEqual([])
  })
})

describe('branchFingerprints（真实 git，独立双仓）', () => {
  it('同补丁不同 SHA → 指纹相同；单向补丁 → 仅入一侧', async () => {
    // 两个完全独立 init 的仓；先各补一个不同内容的提交，确保两仓 HEAD SHA 必然不同（同秒创建的初始提交会字节级相同——仓库既定经验）
    const a = createOriginRepo('gsm-pa-')
    const b = createOriginRepo('gsm-pb-')
    a.commitFile('a-base.txt', 'a\n')
    b.commitFile('b-base.txt', 'b\n')
    a.git(['checkout', '-b', 'side'])
    const shaA = a.commitFile('fix.txt', 'same content\n')
    b.git(['checkout', '-b', 'side'])
    const shaB = b.commitFile('fix.txt', 'same content\n')
    expect(shaA).not.toBe(shaB) // 独立历史

    const ma = join(mkdtempSync(join(tmpdir(), 'gsm-pa-m-')), 'm.git')
    const mb = join(mkdtempSync(join(tmpdir(), 'gsm-pb-m-')), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)

    const fa = await branchFingerprints(ma, 'side', [])
    const fb = await branchFingerprints(mb, 'side', [])
    // 双方各自含 README 提交 + fix.txt 提交；README 补丁相同 → README 指纹也相同
    const fixA = fa.find(f => f.sha === shaA)!
    const fixB = fb.find(f => f.sha === shaB)!
    expect(fixA.patchId).toBe(fixB.patchId) // 同补丁不同 SHA → 指纹一致

    // A 侧再加一个 B 没有的补丁（真实 git：镜像不会自动同步，需显式 fetch 刷新）
    a.git(['checkout', 'side'])
    const onlySha = a.commitFile('extra.txt', 'extra\n')
    await fetchMirror(ma)
    const fa2 = await branchFingerprints(ma, 'side', [])
    const refreshed = fa2.find(f => f.sha === onlySha)!
    expect(fb.some(f => f.patchId === refreshed.patchId)).toBe(false)
  })

  it('pathspec 过滤：排除目录中的改动不进指纹', async () => {
    const origin = createOriginRepo('gsm-pc-')
    // fixture commitFile 为裸 writeFileSync，子目录需先创建（探针实证：ENOENT）
    mkdirSync(join(origin.dir, 'vendor'), { recursive: true })
    origin.commitFile('vendor/lib.js', 'x')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-pc-m-')), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const withVendor = await branchFingerprints(mirrorDir, 'master', [])
    const withoutVendor = await branchFingerprints(mirrorDir, 'master', buildPathspecs([], ['vendor/**']))
    expect(withVendor.length).toBe(withoutVendor.length + 1)
  })

  it('include 过滤：include 模式外的改动不进指纹', async () => {
    const origin = createOriginRepo('gsm-pe-')
    // fixture commitFile 为裸 writeFileSync，子目录需先创建（探针实证：ENOENT）
    mkdirSync(join(origin.dir, 'vendor'), { recursive: true })
    const shaVendor = origin.commitFile('vendor/x.js', 'vendor-x')
    mkdirSync(join(origin.dir, 'src'), { recursive: true })
    const shaSrc = origin.commitFile('src/y.js', 'src-y')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-pe-m-')), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const fps = await branchFingerprints(mirrorDir, 'master', buildPathspecs(['src/**'], []))
    expect(fps.some(f => f.sha === shaSrc)).toBe(true)
    expect(fps.some(f => f.sha === shaVendor)).toBe(false)
  })

  it('runGit input 参数喂 stdin（真实 patch-id 管道）', async () => {
    const origin = createOriginRepo('gsm-pd-')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-pd-m-')), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mirrorDir, encoding: 'utf8' }).stdout.trim()
    // 简报实证修正：diff-tree 对根提交默认不产出补丁，需 --root 才能喂出真实补丁（探针验证）
    const diff = runGitSync(mirrorDir, ['diff-tree', '-p', '--root', head])
    const r = await runGit(mirrorDir, ['patch-id', '--stable'], { input: diff })
    expect(r.stdout.trim().endsWith(head)).toBe(true)
  })
})
