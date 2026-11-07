import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runGit } from './gitRunner.js'

export type RefSnapshot = { [branch: string]: string }

export async function ensureMirror(url: string, dir: string): Promise<'cloned' | 'existing'> {
  if (existsSync(dir)) return 'existing'
  mkdirSync(dirname(dir), { recursive: true })
  await runGit(process.cwd(), ['clone', '--mirror', url, dir])
  return 'cloned'
}

export async function fetchMirror(dir: string): Promise<void> {
  await runGit(dir, ['fetch', '--prune', 'origin'])
}

export async function snapshotRefs(dir: string): Promise<RefSnapshot> {
  const { stdout } = await runGit(dir, [
    'for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)'
  ])
  const snap: RefSnapshot = {}
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    snap[line.slice(0, tab)] = line.slice(tab + 1)
  }
  return snap
}
