import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { matchesGlob } from './util/glob.js'

const repoSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  defaultBranch: z.string().min(1).default('master'),
  branchExclude: z.array(z.string()).default([]),
  pollIntervalSeconds: z.number().int().min(5).default(30)
})

const configSchema = z.object({
  repos: z.array(repoSchema).min(1),
  server: z
    .object({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).default(43900) })
    .default({})
})

export type RepoConfig = z.infer<typeof repoSchema>
export type AppConfig = z.infer<typeof configSchema>

export function loadConfig(path: string): AppConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`无法读取配置文件 ${path}: ${(e as Error).message}`)
  }
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`配置不合法: ${detail}`)
  }
  return parsed.data
}

export function isBranchExcluded(branch: string, patterns: string[]): boolean {
  return patterns.some(p => matchesGlob(branch, p))
}
