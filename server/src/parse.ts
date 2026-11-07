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
    const lines = record.replace(/^\s*\n/, '').trim().split('\n')
    // rev-list --format 每条记录先输出 "commit <sha>" 头行（git log 无此行为），剥离
    if (lines[0]?.startsWith('commit ')) lines.shift()
    if (!lines[0]) continue
    let sha: string
    let fields: string[]
    if (lines[0].includes('\x1f')) {
      // 真实布局：头行后 <sha> 与字段同行，\x1f 分隔；按 \n 拼回保证含换行的 body 完整
      fields = lines.join('\n').split('\x1f')
      sha = fields.shift() ?? ''
    } else {
      // 兼容无头行布局：<sha> 单独一行，字段从下一行开始
      if (lines.length < 2) continue
      sha = lines[0].trim()
      fields = lines.slice(1).join('\n').split('\x1f')
    }
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
