import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitCommandError, runGit } from '../src/gitRunner.js'

describe('runGit', () => {
  it('执行 git --version 并返回 stdout', async () => {
    const r = await runGit(process.cwd(), ['--version'])
    expect(r.stdout).toContain('git version')
  })

  it('失败命令抛 GitCommandError 且带 stderr', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'gsm-norepo-'))
    const err = await runGit(notARepo, ['status']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    expect((err as GitCommandError).stderr.length).toBeGreaterThan(0)
  })

  it('超时 kill 并报超时错误', async () => {
    await expect(runGit('.', ['5'], { timeoutMs: 100, bin: 'sleep' })).rejects.toThrow(/超时/)
  })

  it('大体积多字节输出跨 chunk 边界不损坏', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsm-bigout-'))
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(`第${i}行：中文提交主题测试，多字节UTF8。`)
    const expected = lines.join('\n') + '\n'
    const bigFile = join(dir, 'big.txt')
    writeFileSync(bigFile, expected, 'utf8')
    const r = await runGit('.', [bigFile], { bin: 'cat' })
    expect(r.stdout).toBe(expected)
  })
})
