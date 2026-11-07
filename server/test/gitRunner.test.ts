import { mkdtempSync } from 'node:fs'
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
})
