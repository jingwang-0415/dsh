import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitCommandError, pipeRunGit, runGit } from '../src/gitRunner.js'
import { cleanupTracked, createOriginRepo, trackTmp } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'

afterEach(cleanupTracked)

describe('runGit', () => {
  it('执行 git --version 并返回 stdout', async () => {
    const r = await runGit(process.cwd(), ['--version'])
    expect(r.stdout).toContain('git version')
  })

  it('失败命令抛 GitCommandError 且带 stderr', async () => {
    const notARepo = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-norepo-')))
    const err = await runGit(notARepo, ['status']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    expect((err as GitCommandError).stderr.length).toBeGreaterThan(0)
  })

  it('超时 kill 并报超时错误', async () => {
    await expect(runGit('.', ['5'], { timeoutMs: 100, bin: 'sleep' })).rejects.toThrow(/超时/)
  })

  it('大体积多字节输出跨 chunk 边界不损坏', async () => {
    const dir = trackTmp(mkdtempSync(join(tmpdir(), 'gsm-bigout-')))
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(`第${i}行：中文提交主题测试，多字节UTF8。`)
    const expected = lines.join('\n') + '\n'
    const bigFile = join(dir, 'big.txt')
    writeFileSync(bigFile, expected, 'utf8')
    const r = await runGit('.', [bigFile], { bin: 'cat' })
    expect(r.stdout).toBe(expected)
  })
})

describe('pipeRunGit 双进程流式', () => {
  it('log -p → patch-id 直连：≤5 行且末列 sha ∈ HEAD 历史', async () => {
    const origin = createOriginRepo('gsm-pipe-')
    origin.git(['checkout', '-b', 'dev'])
    origin.commitFile('x1.txt', '1\n')
    origin.commitFile('x2.txt', '2\n')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-pipe-m-'))), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    // 契约修正（探针实证）：plan 原文 rev-list --pretty=format:%H 无 -p → 不产出补丁文本，patch-id 必然空输出；
    // rev-list 不支持 -p（log 专属 diff 选项），故用 log -p（即 branchFingerprints 实际参数形态）
    const r = await pipeRunGit(
      mirrorDir,
      ['log', '--max-count=5', '-p', '--no-merges', '--pretty=format:%H', 'HEAD'],
      mirrorDir,
      ['patch-id', '--stable']
    )
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(5)
    const history = await runGit(mirrorDir, ['rev-list', 'HEAD'])
    const ids = history.stdout.split('\n').filter(Boolean)
    for (const line of lines) {
      const cols = line.trim().split(' ')
      expect(cols).toHaveLength(2)
      expect(ids).toContain(cols[1])
    }
  })

  it('A 非 0 → GitCommandError(argsA) 且带 stderr', async () => {
    const origin = createOriginRepo('gsm-pipea-')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-pipea-m-'))), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const err = await pipeRunGit(mirrorDir, ['log', 'refs/heads/nope'], mirrorDir, ['patch-id', '--stable'])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    expect((err as GitCommandError).args).toEqual(['log', 'refs/heads/nope'])
    expect((err as GitCommandError).stderr.length).toBeGreaterThan(0)
  })

  it('B 非 0 → GitCommandError(argsB)', async () => {
    const origin = createOriginRepo('gsm-pipeb-')
    const mirrorDir = join(trackTmp(mkdtempSync(join(tmpdir(), 'gsm-pipeb-m-'))), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const err = await pipeRunGit(mirrorDir, ['log', '-p', '--pretty=format:%H', 'HEAD'], mirrorDir, ['patch-id', '--bogus'])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    expect((err as GitCommandError).args).toEqual(['patch-id', '--bogus'])
  })

  it('超时双 kill：双进程同时被 SIGKILL 并报超时', async () => {
    await expect(
      pipeRunGit('.', ['30'], '.', ['30'], { timeoutMs: 300, bin: 'sleep' })
    ).rejects.toThrow(/超时/)
  })

  it('spawn 失败（bin 不存在）双方 error handler 兜底 reject 不悬挂', async () => {
    await expect(
      pipeRunGit('.', ['--version'], '.', ['--version'], { bin: 'gsm-no-such-bin-xyz' })
    ).rejects.toThrow(/gsm-no-such-bin-xyz|ENOENT/)
  })
})
