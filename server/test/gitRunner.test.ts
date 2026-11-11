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

  it('超时后孙进程持管道也必须 settle（销毁我方流强制 close）', async () => {
    // 线上实证（fix round 2）：git fetch 超时 SIGKILL 直接子进程后，孙进程 git remote-https
    // 继承并持有 stdio 管道写端 → 'close' 要等孙进程退出才触发 → Promise 永不 settle
    // （fetch_events 永久 running、调度器互斥锁卡死）。
    // sh -c 'sleep 30 & wait'：SIGKILL sh 后 sleep 孙进程继承管道存活 30s——
    // 无修复时 'close' 要等 30s（本用例 2s 超时必炸）；修复后 ~300ms 内以超时错误 reject。
    await expect(runGit('.', ['-c', 'sleep 30 & wait'], { bin: 'sh', timeoutMs: 300 }))
      .rejects.toThrow(/超时/)
  }, { timeout: 2000 })

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

  it('GitCommandError message 脱敏内嵌凭据（args 与 stderr 均过 sanitize），stderr 字段保持原样', async () => {
    // 探针实证：现代 git 在 transport 错误里自会抹掉 userinfo（'unable to access' 不回显凭据），
    // 真实泄漏面是我方 message 拼装的 args.join（RED 实证含原始 token）；stderr 侧 sanitize 为防御性保留。
    // 端到端触发用 connection refused（127.0.0.1:1，~30ms 确定性失败）——invalid.invalid 的 DNS
    // 失败时延随环境波动（1.2s → >5s 超时），不可作测试依赖
    const err = await runGit('.', ['ls-remote', 'https://user:secretToken@127.0.0.1:1/x.git'])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    const msg = (err as GitCommandError).message
    expect(msg).toContain('***@')
    expect(msg).not.toContain('secretToken')

    // "stderr 字段保持原样"契约在构造器层钉住：git 自身已脱敏 transport 错误 stderr，
    // 端到端无法构造"stderr 含原始 token"的真实场景；生产侧唯一拼装点即构造器，
    // 直接构造即可钉住分界——message 脱敏、字段不脱敏（依赖 stderr 原样的调用方不受影响）
    const ctor = new GitCommandError(
      ['fetch', 'https://u:secretToken@host.invalid/x.git'],
      128,
      'stderr echo: https://u:secretToken@host.invalid/x.git'
    )
    expect(ctor.message).toContain('***@')
    expect(ctor.message).not.toContain('secretToken')
    expect(ctor.stderr).toContain('secretToken')
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

  it('超时孙进程持管道也必须 settle（kill 双进程 + destroy 全部流强制 close）', async () => {
    // 同 runGit 孙进程场景（fix round 2）：双进程各带 sleep 孙进程继承管道写端——
    // a.close（sleep 持 a.stdout/a.stderr 写端）与 b.close（sleep 持 b.stdout/b.stderr 写端）
    // 双双不触发 → 无修复时 Promise 永不 settle（本用例 2s 超时必炸）；修复后超时兜底
    // kill 双进程 + destroy 全部流，~300ms 内以超时错误 reject。
    // 探针实证：B=-c cat（单进程形态）在 kill 后 stdio 随退出即关、b.close 立即触发即可
    // settle，复现不了挂起——settle 是"任一 close 即定因"，复现必须让两个 close 全部阻塞，
    // 故 B 也用挂起形态（与审查草案 B=cat 的差异在此，已实证裁定）。
    // 注：pipeRunGit 单 bin 作用于双进程，双侧均为 sh -c 形态。
    await expect(
      pipeRunGit('.', ['-c', 'sleep 30 & wait'], '.', ['-c', 'sleep 30 & wait'], { bin: 'sh', timeoutMs: 300 })
    ).rejects.toThrow(/超时/)
  }, { timeout: 2000 })

  it('spawn 失败（bin 不存在）双方 error handler 兜底 reject 不悬挂', async () => {
    await expect(
      pipeRunGit('.', ['--version'], '.', ['--version'], { bin: 'gsm-no-such-bin-xyz' })
    ).rejects.toThrow(/gsm-no-such-bin-xyz|ENOENT/)
  })
})
