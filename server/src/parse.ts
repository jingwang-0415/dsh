export interface CommitInfo {
  sha: string
  authorName: string
  authorEmail: string
  committedAt: number
  subject: string
  body: string
}

export const REVLIST_FORMAT = '--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e'

export function parseRevList(raw: string): CommitInfo[] {
  const out: CommitInfo[] = []
  for (const record of raw.split('\x1e')) {
    const trimmed = record.replace(/^\s*\n/, '').trim()
    if (!trimmed) continue
    const nl = trimmed.indexOf('\n')
    if (nl === -1) continue
    const sha = trimmed.slice(0, nl).trim()
    const fields = trimmed.slice(nl + 1).split('\x1f')
    out.push({
      sha,
      authorName: fields[0] ?? '',
      authorEmail: fields[1] ?? '',
      committedAt: Number(fields[2]) || 0,
      subject: fields[3] ?? '',
      body: fields.slice(4).join('\x1f').trimEnd()
    })
  }
  return out
}
