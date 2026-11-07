import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror, fetchMirror, snapshotRefs } from '../src/mirror.js'

describe('mirror', () => {
  it('ensureMirror 首次克隆，二次复用', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    expect(await ensureMirror(origin.dir, mirrorDir)).toBe('cloned')
    expect(await ensureMirror(origin.dir, mirrorDir)).toBe('existing')
  })

  it('fetch 后快照可见新分支', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    let snap = await snapshotRefs(mirrorDir)
    expect(Object.keys(snap)).toEqual(['master'])

    origin.git(['checkout', '-b', 'release/1.0'])
    origin.commitFile('rel.txt', 'r1')
    origin.git(['checkout', 'master'])
    await fetchMirror(mirrorDir)
    snap = await snapshotRefs(mirrorDir)
    expect(Object.keys(snap).sort()).toEqual(['master', 'release/1.0'])
    expect(snap['master']).toMatch(/^[0-9a-f]{40}$/)
  })
})
