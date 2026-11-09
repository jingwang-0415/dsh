import { spawn } from 'node:child_process'

export interface GitResult { stdout: string; stderr: string }

export interface RunGitOptions { timeoutMs?: number; bin?: string; input?: string }

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly exitCode: number | null, readonly stderr: string) {
    super(`git ${args.join(' ')} 失败 (code=${exitCode}): ${stderr.trim()}`)
  }
}

export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const { timeoutMs = 60_000, bin = 'git', input } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    child.stdin?.on('error', () => {})
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
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
// - 超时：单 timer 双 SIGKILL，首个 close 落地即报超时
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

    const timer = setTimeout(() => {
      timedOut = true
      a.kill('SIGKILL')
      b.kill('SIGKILL')
    }, timeoutMs)

    const settle = (err?: unknown, result?: GitResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      a.kill('SIGKILL') // 幂等：已退出进程返回 false；失败路径防进程泄漏
      b.kill('SIGKILL')
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
