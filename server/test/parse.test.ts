import { describe, expect, it } from 'vitest'
import { parseRevList } from '../src/parse.js'

describe('parseRevList', () => {
  it('解析 \\x1f/\\x1e 分隔的 rev-list 输出', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ['Alice', 'alice@x.com', '1700000000', 'add a', 'body line 1\nbody line 2'].join('\x1f'),
      '\x1e',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ['Bob', 'bob@x.com', '1700000100', 'fix: b', ''].join('\x1f'),
      '\x1e'
    ].join('\n')
    const commits = parseRevList(raw)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      sha: 'a'.repeat(40), authorName: 'Alice', authorEmail: 'alice@x.com',
      committedAt: 1700000000, subject: 'add a', body: 'body line 1\nbody line 2'
    })
    expect(commits[1].body).toBe('')
    expect(commits[1].authorName).toBe('Bob')
  })

  it('空输出返回空数组', () => {
    expect(parseRevList('')).toEqual([])
  })
})
