import { runGit } from './gitRunner.js'

export interface Fingerprint { patchId: string; sha: string }

export function buildPathspecs(include: string[], exclude: string[]): string[] {
  return [
    ...include.map(p => `:(glob)${p}`),
    ...exclude.map(p => `:(exclude,glob)${p}`)
  ]
}

export function parsePatchIds(raw: string): Fingerprint[] {
  const out: Fingerprint[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sp = trimmed.lastIndexOf(' ')
    if (sp === -1) continue
    out.push({ patchId: trimmed.slice(0, sp), sha: trimmed.slice(sp + 1) })
  }
  return out
}

export async function branchFingerprints(
  mirrorDir: string, branch: string, pathspecs: string[]
): Promise<Fingerprint[]> {
  const args = ['log', `refs/heads/${branch}`, '-p', '--no-merges', '--pretty=format:%H', ...pathspecs]
  const { stdout: patchText } = await runGit(mirrorDir, args)
  const { stdout: idText } = await runGit(mirrorDir, ['patch-id', '--stable'], { input: patchText })
  return parsePatchIds(idText)
}
