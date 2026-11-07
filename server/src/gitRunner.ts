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
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout!.on('data', (d: Buffer) => { stdout += d })
    child.stderr!.on('data', (d: Buffer) => { stderr += d })
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${bin} ${args.join(' ')} 超时 (${timeoutMs}ms)`))
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new GitCommandError(args, code, stderr))
    })
  })
}
