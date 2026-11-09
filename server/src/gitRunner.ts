import { spawn } from 'node:child_process'

export interface GitResult { stdout: string; stderr: string }

export interface RunGitOptions { timeoutMs?: number; bin?: string; input?: string; env?: Record<string, string> }

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly exitCode: number | null, readonly stderr: string) {
    super(`git ${args.join(' ')} 失败 (code=${exitCode}): ${stderr.trim()}`)
  }
}

export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const { timeoutMs = 60_000, bin = 'git', input, env } = opts
  return new Promise((resolve, reject) => {
    // env：存在时在 process.env 基础上覆盖（不整体替换——PATH 等系统变量必须继承，
    // 否则 spawn 按名解析 git 失败）；不存在时不带 env 键，行为与调用方未传时逐字节一致
    const spawnOpts: Parameters<typeof spawn>[2] = {
      cwd, stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      ...(env !== undefined && { env: { ...process.env, ...env } })
    }
    const child = spawn(bin, args, spawnOpts)
    child.stdin?.on('error', () => {})
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      // fix round 2（线上实证）：孙进程（git fetch → git remote-https）继承 stdio 管道写端，
      // 仅 kill 直接子进程时 'close' 要等孙进程退出才触发 → Promise 永不 settle
      // （fetch_events 永久 running、调度器互斥锁卡死、后续轮询全 skipped）。
      // 销毁我方管道端强制触发 'close'（Node 语义：exit + stdio 关闭 → close，
      // 即使孙进程仍持对端 fd）；非超时路径不经此处，自然 close 流程零改动
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, timeoutMs)
    child.stdout!.on('data', (d: Buffer) => { stdoutChunks.push(d) })
    child.stderr!.on('data', (d: Buffer) => { stderrChunks.push(d) })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    if (input !== undefined) child.stdin!.end(input)
    child.on('close', code => {
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (timedOut) reject(new Error(`${bin} ${args.join(' ')} 超时 (${timeoutMs}ms)`))
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new GitCommandError(args, code, stderr))
    })
  })
}

export interface PipeRunGitOptions { timeoutMs?: number; bin?: string }

// 双进程管道：A.stdout 直连 B.stdin（如 git log -p | git patch-id --stable），
// 补丁文本不再整段驻留内存（大仓化）。生命周期裁定：
// - end 所有权单一：pipe(end:false)，仅 A 'close'(0) 后 b.stdin.end()，避免 pipe 自动 end 与手动 end 竞争
// - A error（含 spawn ENOENT）→ settle + 双 kill 兜底，B 不因失去输入 EOF 而悬挂到超时
// - 错误归因先到先得：首个非零 close 定因（B 先死时 A 多为 SIGPIPE 连带，root cause 归 B）
// - 超时：单 timer 双 SIGKILL + destroy 全部流，首个 close 落地即报超时
// - 孙进程持管道（fix round 2，线上实证）：仅 kill 直接子进程时，继承 stdio 管道写端的
//   孙进程会让 'close' 等到孙进程退出才触发 → Promise 永不 settle；destroy 我方流强制 close
// - spawn 失败 Node 保证 'close' 跟随 'error'，settled 守卫使幂等
export async function pipeRunGit(
  cwdA: string, argsA: string[], cwdB: string, argsB: string[],
  opts: PipeRunGitOptions = {}
): Promise<GitResult> {
  const { timeoutMs = 120_000, bin = 'git' } = opts
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let aCode: number | null | undefined
    let bCode: number | null | undefined
    const stderrA: Buffer[] = []
    const stderrB: Buffer[] = []
    const stdoutB: Buffer[] = []

    const a = spawn(bin, argsA, { cwd: cwdA, stdio: ['ignore', 'pipe', 'pipe'] })
    const b = spawn(bin, argsB, { cwd: cwdB, stdio: ['pipe', 'pipe', 'pipe'] })

    // 销毁我方全部管道端（幂等）：已结束/已关闭的流 destroy 为无害 no-op。
    // A 侧 stdio[0] 是 'ignore'（无 stdin 管道），实际可销毁为五流
    const destroyPipes = (): void => {
      a.stdout?.destroy()
      a.stderr?.destroy()
      b.stdin?.destroy()
      b.stdout?.destroy()
      b.stderr?.destroy()
    }

    const timer = setTimeout(() => {
      timedOut = true
      a.kill('SIGKILL')
      b.kill('SIGKILL')
      destroyPipes() // 孙进程持管道场景：不等自然 close，强制双 'close' 落地
    }, timeoutMs)

    const settle = (err?: unknown, result?: GitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      a.kill('SIGKILL') // 幂等：已退出进程返回 false；失败路径防进程泄漏
      b.kill('SIGKILL')
      // 失败/超时兜底销毁流，杜绝残留管道悬挂；成功路径（双 close(0)）流已自然结束，
      // 保持零改动不 destroy（避免任何理论上的缓冲数据扰动）
      if (err !== undefined || timedOut) destroyPipes()
      if (err !== undefined) reject(err as Error)
      else resolve(result as GitResult)
    }

    const tryFinish = () => {
      if (aCode === undefined || bCode === undefined || settled) return
      if (aCode === 0 && bCode === 0) {
        settle(undefined, {
          stdout: Buffer.concat(stdoutB).toString('utf8'),
          stderr: Buffer.concat(stderrB).toString('utf8')
        })
      }
    }

    a.stdout!.pipe(b.stdin!, { end: false })
    b.stdin!.on('error', () => {}) // B 先亡（如坏 flag）时 pipe 写入 EPIPE 静默，语义归 B 非 0 close
    a.stderr!.on('data', (d: Buffer) => { stderrA.push(d) })
    b.stdout!.on('data', (d: Buffer) => { stdoutB.push(d) })
    b.stderr!.on('data', (d: Buffer) => { stderrB.push(d) })

    a.on('error', err => settle(err))
    b.on('error', err => settle(err))

    a.on('close', code => {
      if (settled) return
      aCode = code
      if (timedOut) settle(new Error(`${bin} ${argsA.join(' ')} | ${bin} ${argsB.join(' ')} 超时 (${timeoutMs}ms)`))
      else if (code !== 0) settle(new GitCommandError(argsA, code, Buffer.concat(stderrA).toString('utf8')))
      else {
        b.stdin!.end() // A 正常结束 → EOF 给 B（正常流关闭；end: false 由本处收尾）
        tryFinish()
      }
    })

    b.on('close', code => {
      if (settled) return
      bCode = code
      if (timedOut) settle(new Error(`${bin} ${argsA.join(' ')} | ${bin} ${argsB.join(' ')} 超时 (${timeoutMs}ms)`))
      else if (code !== 0) settle(new GitCommandError(argsB, code, Buffer.concat(stderrB).toString('utf8')))
      else tryFinish()
    })
  })
}
