import { spawn } from 'node:child_process'

export interface GitResult { stdout: string; stderr: string }

export interface RunGitOptions { timeoutMs?: number; bin?: string }

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly exitCode: number | null, readonly stderr: string) {
    super(`git ${args.join(' ')} 失败 (code=${exitCode}): ${stderr.trim()}`)
  }
}

export async function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> {
  const { timeoutMs = 60_000, bin = 'git' } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout!.on('data', (d: Buffer) => { stdoutChunks.push(d) })
    child.stderr!.on('data', (d: Buffer) => { stderrChunks.push(d) })
    child.on('error', err => { clearTimeout(timer); reject(err) })
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
