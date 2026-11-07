# v1.1 跨仓库差异统计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v1.0 监控站上增加跨仓库源码级差异统计：GitHub/Gitee 双仓同名分支配对、patch-id 指纹匹配（含路径过滤）、多仓调度与跨仓对比视图。

**Architecture:** patch-id 指纹经 `git log -p | git patch-id --stable`（stdin 管道由 GitRunner input 参数承载）按 (mirror, branch) 批量计算；纯函数归并只入/独有/配对；app.ts 按 config.repos 循环建 Scheduler；新端点 /api/crossrepo/*；前端新增 CrossRepo 视图与 Overview 仓库选择器。

**Tech Stack:** 沿用 v1.0（Node 20+/Electron 运行时、Fastify 5、better-sqlite3 13、Vue 3、vitest、真实 git fixture）。

**Spec:** docs/superpowers/specs/2026-11-07-crossrepo-diff-design.md（绑定权威）

## Global Constraints

- 沿用 v1.0 全部约束：TS strict、ESM .js 后缀、git 全 spawn 参数数组、对远端只读、真实 fixture 不 mock git 语义、conventional commits、测试全绿才提交（当前基线 server 63/63 + web 5/5）。
- 同秒制造提交对象的 fixture 步骤必须保证对象字节必然不同（--date/amend 先例）。
- 分支名以 `refs/heads/<name>` 单一 argv 元素传入；用户输入的 glob 以独立 pathspec 元素传入（`:(glob)`/`:(exclude,glob)` 前缀），禁止 shell。

## File Structure

```
server/src/
├── gitRunner.ts      [改] RunGitOptions 增 input?: string（stdin 喂入）
├── patchid.ts        [新] buildPathspecs / branchFingerprints / parsePatchIds
├── crossrepo.ts      [新] mergePatchMaps / showCommits / crossCompare 编排
├── app.ts            [改] 多仓 Scheduler 循环、SSE 带 repoId、repos upsert 循环
├── api.ts            [改] repo 作用域参数 + /api/crossrepo/* 两端点
├── index.ts          [改] schedulers.forEach(start)
web/src/
├── api.ts            [改] 跨仓类型与两个调用函数
├── views/CrossRepo.vue  [新] 跨仓对比视图
├── views/Overview.vue   [改] 仓库选择器
├── router.ts / App.vue [改] 新路由与导航
web/test/CrossRepo.test.ts [新]
server/test/{patchid,crossrepo,multirepo,api}.test.ts
```

---

### Task 1: 多仓调度与 repo 作用域 API

**Files:**
- Modify: `server/src/app.ts`、`server/src/api.ts`、`server/src/index.ts`
- Test: `server/test/api.test.ts`（追加）、`server/test/multirepo.test.ts`（新）

**Interfaces:**
- Consumes: v1.0 全部模块（Scheduler/ApiDeps 现状见 server/src/app.ts、api.ts）
- Produces:
  - `AppHandle.schedulers: Scheduler[]`（替换原 `scheduler` 单数；`schedulers[i]` 对应 `config.repos[i]`）；close() 停全部
  - SSE 载荷：`commits.new {repoId, branch, count, subjects}`、`branches.updated {repoId}`、`status.changed {repoId, ...status}`
  - API：`/api/status`、`/api/branches`、`/api/commits`、`/api/commits/:sha`、`/api/commits/:sha/inclusion`、`/api/compare` 均增可选 `repo` 参数（缺省第一个仓；未知 → 404 repo_not_found）
  - index.ts：`handle.schedulers.forEach(s => s.start())`

- [ ] **Step 1: 写失败测试 `server/test/multirepo.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

describe('多仓调度与 repo 作用域（真实 git）', () => {
  let o1: ReturnType<typeof createOriginRepo>
  let o2: ReturnType<typeof createOriginRepo>
  let handle: AppHandle

  beforeAll(async () => {
    o1 = createOriginRepo('gsm-mr1-')
    o2 = createOriginRepo('gsm-mr2-')
    const cfg: AppConfig = {
      repos: [
        { id: 'r1', url: o1.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
        { id: 'r2', url: o2.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }
      ],
      server: { host: '127.0.0.1', port: 43900 }
    }
    handle = await buildApp({ configOverride: cfg, dataDir: mkdtempSync(join(tmpdir(), 'gsm-mr-data-')) })
    for (const s of handle.schedulers) await s.runOnce()
  })

  afterAll(async () => { await handle.close() })

  it('两个 scheduler 各自回填各自的仓', async () => {
    const r1 = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=r1' })
    const r2 = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=r2' })
    expect(r1.json().map((b: { name: string }) => b.name)).toEqual(['master'])
    expect(r2.json().map((b: { name: string }) => b.name)).toEqual(['master'])
    expect(r1.json()[0].headSha).not.toBe(r2.json()[0].headSha)
  })

  it('缺省 repo = 第一个仓；未知 repo → 404 repo_not_found', async () => {
    const dflt = await handle.app.inject({ method: 'GET', url: '/api/branches' })
    expect(dflt.json()[0].headSha).toMatch(/^[0-9a-f]{40}$/)
    const nf = await handle.app.inject({ method: 'GET', url: '/api/branches?repo=nope' })
    expect(nf.statusCode).toBe(404)
    expect(nf.json().code).toBe('repo_not_found')
  })

  it('r2 新提交只被 r2 的 scheduler 检出（repoId 正确）', async () => {
    o2.commitFile('only2.txt', 'x')
    const s2 = handle.schedulers[1]
    const r = await s2.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(1)
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?repo=r2&branch=master' })
    expect(res.json().map((c: { subject: string }) => c.subject)).toContain('add only2.txt')
    const r1res = await handle.app.inject({ method: 'GET', url: '/api/commits?repo=r1&branch=master' })
    expect(r1res.json().map((c: { subject: string }) => c.subject)).not.toContain('add only2.txt')
  })

  it('/api/status?repo= 返回对应仓状态', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/status?repo=r2' })
    expect(res.statusCode).toBe(200)
    expect(res.json().mirrorDir).toContain(join('repos', 'r2'))
    expect(res.json().repoId).toBe('r2')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test test/multirepo.test.ts`
Expected: FAIL —— buildApp 无 `schedulers` 字段 / repo 参数 404 缺失。

- [ ] **Step 3: 改造 app.ts 多仓循环**

`server/src/app.ts` 关键变更（装配段）：

```ts
  const schedulers: Scheduler[] = config.repos.map(repo => {
    const mirrorDir = mirrorDirFor(repo.id)
    // repos 登记改 upsert（逐仓）
    db.prepare(
      `INSERT INTO repos (id, url, default_branch, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET url=excluded.url, default_branch=excluded.default_branch`
    ).run(repo.id, repo.url, repo.defaultBranch, Date.now())
    const s = new Scheduler({
      db, repo, mirrorDir,
      handlers: {
        onCommitsNew: (branch, commits) => sse.publish('commits.new', {
          repoId: repo.id, branch, count: commits.length,
          subjects: commits.slice(0, 5).map(c => c.subject)
        }),
        onBranchesUpdated: () => sse.publish('branches.updated', { repoId: repo.id }),
        onStatus: st => sse.publish('status.changed', { repoId: repo.id, ...st })
      }
    })
    return s
  })
```

`registerApi` deps 传 `schedulers` 与 `config`（api.ts 内自取 `repoById`）；`AppHandle` 返回 `{ app, config, schedulers, sse, close }`；close() 为 `schedulers.forEach(s => s.stop()); await app.close(); db.close()`（sse.closeAll 保持在 app.close 之前）。原 `scheduler` 单数导出删除。
`server/src/index.ts` 启动改 `handle.schedulers.forEach(s => s.start())`。
`server/src/api.ts`：ApiDeps 改 `{ config, db, mirrorDirFor, schedulers, sse, adapter }`；新增：

```ts
function resolveRepo(qRepo: string | undefined): RepoConfig | null {
  if (!qRepo) return config.repos[0]
  return config.repos.find(r => r.id === qRepo) ?? null
}
```

各端点开头 `const repo = resolveRepo((req.query as { repo?: string }).repo)`；null → `reply.code(404).send({ code: 'repo_not_found' })`；`mirrorDir` 改 `mirrorDirFor(repo.id)`；/api/status 返回 `{ repoId: repo.id, ...schedulers[config.repos.indexOf(repo)].status, mirrorDir, lastFetch }`（lastFetch 查询带 repo_id）。

- [ ] **Step 4: 更新受影响测试并全绿**

smoke/api/graceful-shutdown 中 `handle.scheduler` → `handle.schedulers[0]`；api.test 两处 runOnce → `handle.schedulers[0].runOnce()`。
Run: `pnpm -C server test`（63 + multirepo 4 = 67 期望）
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src server/test && git commit -m "feat: 多仓调度循环与 repo 作用域 API/SSE"
```

---

### Task 2: patch-id 指纹引擎

**Files:**
- Modify: `server/src/gitRunner.ts`（input 参数）
- Create: `server/src/patchid.ts`、`server/src/crossrepo.ts`
- Test: `server/test/gitRunner.test.ts`（追加）、`server/test/patchid.test.ts`（新）、`server/test/crossrepo.test.ts`（新）

**Interfaces:**
- Produces:
  - `runGit(cwd, args, opts?: { timeoutMs?; bin?; input?: string })`（input 非 undefined 时 stdin 管道喂入并 end；stdin error 静默）
  - `buildPathspecs(include: string[], exclude: string[]): string[]`（include → `:(glob)p`；exclude → `:(exclude,glob)p`；include 空 = 无 include 项）
  - `branchFingerprints(mirrorDir, branch, pathspecs: string[]): Promise<Fingerprint[]>`
  - `parsePatchIds(raw): Fingerprint[]`（行 "patchId sha"）
  - `type Fingerprint = { patchId: string; sha: string }`
  - `mergePatchMaps(a: Fingerprint[], b: Fingerprint[]): { onlyInA: Fingerprint[]; onlyInB: Fingerprint[]; matched: { patchId; shaA; shaB }[] }`
  - `showCommits(mirrorDir, shas: string[]): Promise<CommitInfo[]>`（`git show -s --format=%H%x1f%an%x1f%ct%x1f%s` 批量）
  - `crossCompare(mirrorA, branchA, mirrorB, branchB, include, exclude): Promise<CrossCompareResult>`（编排：并行指纹 → 归并 → 批量元数据；matched.subjectA 批量一次 showCommits 取得）

- [ ] **Step 1: 写失败测试 `server/test/patchid.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { buildPathspecs, branchFingerprints, parsePatchIds } from '../src/patchid.js'
import { runGit } from '../src/gitRunner.js'

describe('parsePatchIds', () => {
  it('解析 "id sha" 行并忽略空行', () => {
    expect(parsePatchIds('abc123 def456\n\n789aaa bbbccc\n')).toEqual([
      { patchId: 'abc123', sha: 'def456' },
      { patchId: '789aaa', sha: 'bbbccc' }
    ])
  })
})

describe('buildPathspecs', () => {
  it('include/exclude 编译为 git pathspec', () => {
    expect(buildPathspecs(['src/**'], ['vendor/**'])).toEqual([':(glob)src/**', ':(exclude,glob)vendor/**'])
    expect(buildPathspecs([], ['tmp/**'])).toEqual([':(exclude,glob)tmp/**'])
    expect(buildPathspecs([], [])).toEqual([])
  })
})

describe('branchFingerprints（真实 git，独立双仓）', () => {
  it('同补丁不同 SHA → 指纹相同；单向补丁 → 仅入一侧', async () => {
    // 两个完全独立 init 的仓（不同初始内容，确保无共享 SHA）
    const a = createOriginRepo('gsm-pa-')
    const b = createOriginRepo('gsm-pb-')
    a.git(['checkout', '-b', 'side'])
    const shaA = a.commitFile('fix.txt', 'same content\n')
    b.git(['checkout', '-b', 'side'])
    const shaB = b.commitFile('fix.txt', 'same content\n')
    expect(shaA).not.toBe(shaB) // 独立历史

    const ma = join(mkdtempSync(join(tmpdir(), 'gsm-pa-m-')), 'm.git')
    const mb = join(mkdtempSync(join(tmpdir(), 'gsm-pb-m-')), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)

    const fa = await branchFingerprints(ma, 'side', [])
    const fb = await branchFingerprints(mb, 'side', [])
    // 双方各自含 README 提交 + fix.txt 提交；README 补丁相同 → README 指纹也相同
    const fixA = fa.find(f => f.sha === shaA)!
    const fixB = fb.find(f => f.sha === shaB)!
    expect(fixA.patchId).toBe(fixB.patchId) // 同补丁不同 SHA → 指纹一致

    // A 侧再加一个 B 没有的补丁
    a.git(['checkout', 'side'])
    const onlySha = a.commitFile('extra.txt', 'extra\n')
    const fa2 = await branchFingerprints(ma, 'side', [])
    void onlySha
    const refreshed = fa2.find(f => f.sha === onlySha)!
    expect(fb.some(f => f.patchId === refreshed.patchId)).toBe(false)
  })

  it('pathspec 过滤：排除目录中的改动不进指纹', async () => {
    const origin = createOriginRepo('gsm-pc-')
    origin.commitFile('vendor/lib.js', 'x')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-pc-m-')), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const withVendor = await branchFingerprints(mirrorDir, 'master', [])
    const withoutVendor = await branchFingerprints(mirrorDir, 'master', buildPathspecs([], ['vendor/**']))
    expect(withVendor.length).toBe(withoutVendor.length + 1)
  })

  it('runGit input 参数喂 stdin（真实 patch-id 管道）', async () => {
    const origin = createOriginRepo('gsm-pd-')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-pd-m-')), 'm.git')
    await ensureMirror(origin.dir, mirrorDir)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mirrorDir, encoding: 'utf8' }).stdout.trim()
    const diff = runGitSync(mirrorDir, ['diff-tree', '-p', head])
    const r = await runGit(mirrorDir, ['patch-id', '--stable'], { input: diff })
    expect(r.stdout.trim().endsWith(head)).toBe(true)
  })
})
```

（`runGitSync` 为测试内局部 helper：`spawnSync('git', args, {cwd, encoding:'utf8'}).stdout`；顶部 import `spawnSync` 并删除 void。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test test/patchid.test.ts`
Expected: FAIL —— patchid.js 不存在 / runGit 无 input。

- [ ] **Step 3: 扩展 gitRunner（input）**

RunGitOptions 增 `input?: string`；spawn stdio 首项改 `input !== undefined ? 'pipe' : 'ignore'`；child 创建后 `child.stdin?.on('error', () => {})`；`if (input !== undefined) child.stdin!.end(input)`。

- [ ] **Step 4: 实现 `server/src/patchid.ts`**

```ts
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
```

- [ ] **Step 5: 运行 patchid 测试通过**

Run: `pnpm -C server test test/patchid.test.ts test/gitRunner.test.ts`
Expected: PASS（注意 README 补丁在双仓同秒创建时 SHA 相同与否不影响断言——断言只比 patchId；"不同初始内容"由独立 tmpdir 前缀不保证，README 补丁相同是预期，fix.txt 指纹比对是核心断言）。

- [ ] **Step 6: 写失败测试 `server/test/crossrepo.test.ts` 并实现 crossrepo.ts**

测试：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { crossCompare, mergePatchMaps } from '../src/crossrepo.js'
import type { Fingerprint } from '../src/patchid.js'

const f = (patchId: string, sha: string): Fingerprint => ({ patchId, sha })

describe('mergePatchMaps 纯函数', () => {
  it('交集/单向/空集', () => {
    const r = mergePatchMaps([f('p1', 'a1'), f('p2', 'a2')], [f('p2', 'b2'), f('p3', 'b3')])
    expect(r.matched).toEqual([{ patchId: 'p2', shaA: 'a2', shaB: 'b2' }])
    expect(r.onlyInA.map(x => x.sha)).toEqual(['a1'])
    expect(r.onlyInB.map(x => x.sha)).toEqual(['b3'])
    expect(mergePatchMaps([], []).matched).toEqual([])
  })
})

describe('crossCompare（真实 git 独立双仓）', () => {
  it('同补丁跨仓命中 matched；单向补丁入 onlyIn', async () => {
    const a = createOriginRepo('gsm-ca-')
    const b = createOriginRepo('gsm-cb-')
    a.git(['checkout', '-b', 'dev'])
    const shaSameA = a.commitFile('same.txt', 'identical patch\n')
    const shaOnlyA = a.commitFile('only-a.txt', 'only a\n')
    b.git(['checkout', '-b', 'dev'])
    const shaSameB = b.commitFile('same.txt', 'identical patch\n')

    const ma = join(mkdtempSync(join(tmpdir(), 'gsm-ca-m-')), 'm.git')
    const mb = join(mkdtempSync(join(tmpdir(), 'gsm-cb-m-')), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)

    const r = await crossCompare(ma, 'dev', mb, 'dev', [], [])
    expect(r.matchedPairs.map(p => [p.shaA, p.shaB])).toContainEqual([shaSameA, shaSameB])
    expect(r.onlyInA.map(c => c.sha)).toContain(shaOnlyA)
    expect(r.onlyInB).toHaveLength(0) // README 补丁在双仓指纹相同 → matched
    expect(r.stats).toEqual({ aTotal: r.stats.aTotal, bTotal: r.stats.bTotal, matched: r.matchedPairs.length, onlyA: r.onlyInA.length, onlyB: 0 })
    expect(r.onlyInA.find(c => c.sha === shaOnlyA)!.subject).toBe('add only-a.txt')
  })

  it('exclude 过滤：仅 vendor 改动的提交不进指纹', async () => {
    const a = createOriginRepo('gsm-cc-')
    const b = createOriginRepo('gsm-cc2-')
    a.git(['checkout', '-b', 'dev'])
    a.commitFile('vendor/lib.js', 'x')
    const ma = join(mkdtempSync(join(tmpdir(), 'gsm-cc-m-')), 'm.git')
    const mb = join(mkdtempSync(join(tmpdir(), 'gsm-cc2-m-')), 'm.git')
    await ensureMirror(a.dir, ma)
    await ensureMirror(b.dir, mb)
    const r = await crossCompare(ma, 'dev', mb, 'master', [], ['vendor/**'])
    expect(r.onlyInA).toHaveLength(0) // vendor 改动被排除，A 无其他独有补丁
  })
})
```

实现 `server/src/crossrepo.ts`：

```ts
import { runGit } from './gitRunner.js'
import { branchFingerprints, buildPathspecs, type Fingerprint } from './patchid.js'
import type { CommitInfo } from './parse.js'

export interface MatchedPair { patchId: string; shaA: string; shaB: string; subjectA: string }

export interface CrossCompareResult {
  onlyInA: CommitInfo[]
  onlyInB: CommitInfo[]
  matchedPairs: MatchedPair[]
  stats: { aTotal: number; bTotal: number; matched: number; onlyA: number; onlyB: number }
}

export function mergePatchMaps(a: Fingerprint[], b: Fingerprint[]): {
  onlyInA: Fingerprint[]; onlyInB: Fingerprint[]; matched: { patchId: string; shaA: string; shaB: string }[]
} {
  const bIds = new Map(b.map(x => [x.patchId, x.sha]))
  const aIds = new Map(a.map(x => [x.patchId, x.sha]))
  return {
    onlyInA: a.filter(x => !bIds.has(x.patchId)),
    onlyInB: b.filter(x => !aIds.has(x.patchId)),
    matched: a.filter(x => bIds.has(x.patchId)).map(x => ({ patchId: x.patchId, shaA: x.sha, shaB: bIds.get(x.patchId)! }))
  }
}

export function parseShow(raw: string): CommitInfo[] {
  return raw.split('\n').filter(Boolean).map(line => {
    const [sha, an, ct, s] = line.split('\x1f')
    return { sha, authorName: an ?? '', authorEmail: '', committedAt: Number(ct) || 0, subject: s ?? '', body: '' }
  })
}

export async function showCommits(mirrorDir: string, shas: string[]): Promise<CommitInfo[]> {
  if (shas.length === 0) return []
  const { stdout } = await runGit(mirrorDir, ['show', '-s', '--format=%H%x1f%an%x1f%ct%x1f%s', ...shas])
  return parseShow(stdout)
}

export async function crossCompare(
  mirrorA: string, branchA: string, mirrorB: string, branchB: string,
  include: string[], exclude: string[]
): Promise<CrossCompareResult> {
  const pathspecs = buildPathspecs(include, exclude)
  const [fa, fb] = await Promise.all([
    branchFingerprints(mirrorA, branchA, pathspecs),
    branchFingerprints(mirrorB, branchB, pathspecs)
  ])
  const { onlyInA, onlyInB, matched } = mergePatchMaps(fa, fb)
  const [metaA, metaB, subjectsA] = await Promise.all([
    showCommits(mirrorA, onlyInA.map(x => x.sha)),
    showCommits(mirrorB, onlyInB.map(x => x.sha)),
    showCommits(mirrorA, matched.map(x => x.shaA))
  ])
  const subjectBySha = new Map(subjectsA.map(c => [c.sha, c.subject]))
  return {
    onlyInA: metaA,
    onlyInB: metaB,
    matchedPairs: matched.map(m => ({ patchId: m.patchId, shaA: m.shaA, shaB: m.shaB, subjectA: subjectBySha.get(m.shaA) ?? '' })),
    stats: { aTotal: fa.length, bTotal: fb.length, matched: matched.length, onlyA: onlyInA.length, onlyB: onlyInB.length }
  }
}
```

Run: `pnpm -C server test test/crossrepo.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量回归并提交**

Run: `pnpm -C server test`
Expected: 全绿。

```bash
git add server/src server/test && git commit -m "feat: patch-id 指纹引擎与跨仓归并（含路径过滤与 stdin 管道）"
```

---

### Task 3: 跨仓对比 API

**Files:**
- Modify: `server/src/api.ts`
- Test: `server/test/api.test.ts`（追加）

**Interfaces:**
- Produces:
  - `GET /api/crossrepo/branches?repoA&repoB` → `{ repoA: {id, branches: string[]}, repoB: {id, branches: string[]}, paired: string[], unpairedA: string[], unpairedB: string[] }`（仅 active 分支；404 repo_not_found）
  - `GET /api/crossrepo/compare?repoA&repoB&branchA&branchB&include=a,b&exclude=x` → `{ branchPair: {repoA, branchA, repoB, branchB}, onlyInA, onlyInB, matchedPairs, unpairedBranches, stats }`；缺参数 400 bad_request；未知 repo/branch → 404；GitCommandError → 404 branch_not_found

- [ ] **Step 1: 写失败测试（追加到 server/test/api.test.ts，多仓 describe 块沿用 multirepo 的 o1/o2 形态）**

```ts
// 新 describe（自建两 origin + buildApp，两仓独立历史）
it('crossrepo/branches 同名配对与未配对', async () => {
  o1.git(['checkout', '-b', 'dev'])           // r1 多一个 dev
  o1.git(['checkout', 'master'])
  const res = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/branches?repoA=r1&repoB=r2' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.paired).toEqual(['master'])
  expect(body.unpairedA).toEqual(['dev'])
  expect(body.unpairedB).toEqual([])
})

it('crossrepo/compare 同补丁跨仓命中 + 404/400 契约', async () => {
  // 两仓 master 各自打上同一补丁（不同 SHA）
  const mark = (repo: ReturnType<typeof createOriginRepo>) => repo.commitFile('same-fix.txt', 'identical\n')
  mark(o1); mark(o2)
  for (const s of handle.schedulers) await s.runOnce()
  const res = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=r1&repoB=r2&branchA=master&branchB=master' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.matchedPairs.some((p: { subjectA: string }) => p.subjectA === 'add same-fix.txt')).toBe(true)
  const nf = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=nope&repoB=r2&branchA=master&branchB=master' })
  expect(nf.statusCode).toBe(404)
  const miss = await handle.app.inject({ method: 'GET', url: '/api/crossrepo/compare?repoA=r1&repoB=r2' })
  expect(miss.statusCode).toBe(400)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test test/api.test.ts`
Expected: FAIL —— /api/crossrepo/* 404（路由不存在）。

- [ ] **Step 3: 实现 api.ts 跨仓端点**

```ts
  app.get('/api/crossrepo/branches', async (req, reply) => {
    const q = req.query as { repoA?: string; repoB?: string }
    const [ra, rb] = [resolveRepo(q.repoA), resolveRepo(q.repoB)]
    if (!ra || !rb) return reply.code(404).send({ code: 'repo_not_found' })
    const names = (id: string) => (db.prepare(
      `SELECT name FROM branches WHERE repo_id=? AND status='active' ORDER BY name`).all(id) as { name: string }[]
    ).map(r => r.name)
    const a = names(ra.id); const b = names(rb.id)
    const paired = a.filter(n => b.includes(n))
    return {
      repoA: { id: ra.id, branches: a }, repoB: { id: rb.id, branches: b },
      paired, unpairedA: a.filter(n => !paired.includes(n)), unpairedB: b.filter(n => !paired.includes(n))
    }
  })

  app.get('/api/crossrepo/compare', async (req, reply) => {
    const q = req.query as { repoA?: string; repoB?: string; branchA?: string; branchB?: string; include?: string; exclude?: string }
    if (!q.branchA || !q.branchB) return reply.code(400).send({ code: 'bad_request', message: '缺少 branchA/branchB' })
    const [ra, rb] = [resolveRepo(q.repoA), resolveRepo(q.repoB)]
    if (!ra || !rb) return reply.code(404).send({ code: 'repo_not_found' })
    const split = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean)
    try {
      const result = await crossCompare(mirrorDirFor(ra.id), q.branchA, mirrorDirFor(rb.id), q.branchB, split(q.include), split(q.exclude))
      const pairs = db.prepare(
        `SELECT name FROM branches WHERE repo_id=? AND status='active' AND name=?`
      )
      const branchPair = { repoA: ra.id, branchA: q.branchA, repoB: rb.id, branchB: q.branchB }
      const pairedCheck = (id: string, name: string) => pairs.get(id, name) != null
      const [ba, bb] = [
        (db.prepare(`SELECT name FROM branches WHERE repo_id=? AND status='active'`).all(ra.id) as {name:string}[]).map(x => x.name),
        (db.prepare(`SELECT name FROM branches WHERE repo_id=? AND status='active'`).all(rb.id) as {name:string}[]).map(x => x.name)
      ]
      const paired = ba.filter(n => bb.includes(n))
      return {
        branchPair, ...result,
        unpairedBranches: {
          repoA: ba.filter(n => !paired.includes(n)),
          repoB: bb.filter(n => !paired.includes(n))
        }
      }
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })
```

顶部 import `crossCompare`；`pairedCheck` 若未用则删除（避免死代码）。

- [ ] **Step 4: 全量回归并提交**

Run: `pnpm -C server test`
Expected: 全绿。

```bash
git add server/src/api.ts server/test/api.test.ts && git commit -m "feat: 跨仓对比 API（同名分支配对/patch-id compare）"
```

---

### Task 4: 前端跨仓对比视图与仓库选择器

**Files:**
- Modify: `web/src/api.ts`、`web/src/router.ts`、`web/src/App.vue`、`web/src/views/Overview.vue`
- Create: `web/src/views/CrossRepo.vue`
- Test: `web/test/CrossRepo.test.ts`（新）
- Modify: `README.md`（跨仓对比用法小节）

**Interfaces:**
- Produces: 路由 `/crossrepo`（导航"跨仓对比"）；`api.crossBranches(repoA, repoB)`、`api.crossCompare(params)`；Overview 仓库下拉（切换 → 带 `repo` 参数刷新全部数据）

- [ ] **Step 1: 写失败组件测试 `web/test/CrossRepo.test.ts`**

```ts
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CrossRepo from '../src/views/CrossRepo.vue'

const reposPayload = [
  { id: 'gh', url: 'https://github.com/x/dsh', defaultBranch: 'main', pollIntervalSeconds: 10 },
  { id: 'gte', url: 'git@gitee.com:x/dsh2', defaultBranch: 'main', pollIntervalSeconds: 10 }
]
const branchesPayload = {
  repoA: { id: 'gh', branches: ['main', 'feat'] },
  repoB: { id: 'gte', branches: ['main'] },
  paired: ['main'], unpairedA: ['feat'], unpairedB: []
}
const comparePayload = {
  branchPair: { repoA: 'gh', branchA: 'main', repoB: 'gte', branchB: 'main' },
  onlyInA: [{ sha: 'a'.repeat(40), authorName: 'A', authorEmail: '', committedAt: 1, subject: 'github 独有改动', body: '', firstSeenBranch: null }],
  onlyInB: [{ sha: 'b'.repeat(40), authorName: 'B', authorEmail: '', committedAt: 2, subject: 'gitee 独有改动', body: '', firstSeenBranch: null }],
  matchedPairs: [{ patchId: 'p1', shaA: 'c'.repeat(40), shaB: 'd'.repeat(40), subjectA: '同补丁改动' }],
  unpairedBranches: { repoA: ['feat'], repoB: [] },
  stats: { aTotal: 3, bTotal: 2, matched: 1, onlyA: 1, onlyB: 1 }
}

function routeTo(params: Record<string, string>): Promise<unknown> {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.startsWith('/api/crossrepo/compare')) return comparePayload
      if (url.startsWith('/api/crossrepo/branches')) return branchesPayload
      if (url === '/api/repos') return reposPayload
      return []
    }
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function mountView(query: string) {
  const fetchMock = await routeTo(query)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/crossrepo', component: CrossRepo }] })
  await router.push(`/crossrepo${query}`)
  await router.isReady()
  const wrapper = mount(CrossRepo, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, fetchMock }
}

describe('CrossRepo 视图', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('matched 灰色并排展示 shaA↔shaB，单向独有分区正确', async () => {
    const { wrapper } = await mountView('')
    const html = wrapper.html()
    expect(html).toContain('源码一致（同补丁）')
    expect(html).toContain('github 独有改动')
    expect(html).toContain('gitee 独有改动')
    expect(wrapper.findAll('.row-matched')).toHaveLength(1)
    expect(wrapper.text()).toContain('c'.repeat(12))
    expect(wrapper.text()).toContain('d'.repeat(12))
  })

  it('对比请求携带路径过滤与分支参数', async () => {
    const { fetchMock } = await mountView('?repoA=gh&repoB=gte&branchA=main&branchB=main&exclude=vendor%2F**')
    const called = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.find((u: unknown[]) => String(u[0]).includes('/api/crossrepo/compare'))
    expect(String(called![0])).toContain('exclude=vendor%2F**')
  })
})
```

（若断言与实现细节冲突：保持断言语义，微调选择器/文案为最小修正并声明——既定先例。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C web test`
Expected: FAIL —— CrossRepo.vue 不存在。

- [ ] **Step 3: 实现 api.ts 增量与 CrossRepo.vue**

`web/src/api.ts` 追加：

```ts
export interface CrossBranchesDto {
  repoA: { id: string; branches: string[] }
  repoB: { id: string; branches: string[] }
  paired: string[]
  unpairedA: string[]
  unpairedB: string[]
}
export interface CrossCompareDto {
  branchPair: { repoA: string; branchA: string; repoB: string; branchB: string }
  onlyInA: CommitRow[]
  onlyInB: CommitRow[]
  matchedPairs: { patchId: string; shaA: string; shaB: string; subjectA: string }[]
  unpairedBranches: { repoA: string[]; repoB: string[] }
  stats: { aTotal: number; bTotal: number; matched: number; onlyA: number; onlyB: number }
}
```

api 对象追加（getJson/repos 已有）：

```ts
  crossBranches: (repoA: string, repoB: string): Promise<CrossBranchesDto> =>
    getJson(`/api/crossrepo/branches?repoA=${encodeURIComponent(repoA)}&repoB=${encodeURIComponent(repoB)}`),
  crossCompare: (p: { repoA: string; repoB: string; branchA: string; branchB: string; include?: string[]; exclude?: string[] }): Promise<CrossCompareDto> => {
    const u = new URLSearchParams({ repoA: p.repoA, repoB: p.repoB, branchA: p.branchA, branchB: p.branchB })
    if (p.include?.length) u.set('include', p.include.join(','))
    if (p.exclude?.length) u.set('exclude', p.exclude.join(','))
    return getJson(`/api/crossrepo/compare?${u.toString()}`)
  }
```

`web/src/views/CrossRepo.vue`（完整组件：仓库/分支下拉、include/exclude 输入、统计卡、三区列表——结构同 v1.0 视图风格，matched 区用 `.row-matched` 灰色并排 `shaA[:12] ↔ shaB[:12]`；对比按钮触发 crossCompare；unpaired 分支在下拉中标注"(未配对)"并禁选对方缺失项）。
`web/src/router.ts`：`{ path: '/crossrepo', name: 'crossrepo', component: CrossRepo }`；`App.vue` 导航加 `<RouterLink to="/crossrepo">跨仓对比</RouterLink>`。
`web/src/views/Overview.vue`：顶部加 `<select v-model="repoId">`（选项来自 api.repos），refresh 全部改用带 `repo` 参数的调用（api.branches 支持可选 repo 参数——api.ts 相应小改；status/commits 同理）。

- [ ] **Step 4: web 测试与构建通过、server 回归**

Run: `pnpm -C web test && pnpm -C web build && pnpm -C server test`
Expected: 全绿。

- [ ] **Step 5: README 更新并提交**

README「使用」节追加：

```markdown
- **跨仓对比**（v1.1）：导航"跨仓对比"→ 选两仓库与同名分支 → 可选填排除/仅对比的 glob（如 `vendor/**`、`src/**`）→ 查看双向独有提交与"源码一致（同补丁）"配对。merge 提交不参与指纹；上下文大漂移可能漏配，界面以"源码一致"如实呈现。
```

```bash
git add web/src web/test README.md && git commit -m "feat: 跨仓对比视图（仓库选择/路径过滤/同补丁配对展示）"
```

---

### Task 5（收尾）: 真实双仓端到端验收

**Files:** 无代码；运行验证 + 报告

- [ ] **Step 1:** `pnpm test` + `pnpm build` 全绿
- [ ] **Step 2:** 配置 `~/.git-sync-monitor` 同款双仓配置（GSM_DATA=/tmp/gsm-demo-v11），单实例两仓调度启动（`pnpm exec node server/dist/index.js`）
- [ ] **Step 3:** 实测脚本（真实 GitHub/Gitee）：
  1. GitHub 侧重放 15639d6 同补丁（不同 SHA）→ /api/crossrepo/compare matched 命中
  2. GitHub 侧新独有改动 → onlyInA
  3. exclude=README.md → 差异列表收缩且 README 改动不出现
  4. Gitee 侧无 GitHub 侧新改动 → onlyInB
- [ ] **Step 4:** 报告 + `git add -A && git commit -m "docs: v1.1 验收记录"`（如有验收记录文件）

## 需求覆盖映射

| 用户需求 | 任务 |
|---------|------|
| 1 源码层级确定差异 | T2（patch-id 指纹+归并）、T3（compare API）、T4（视图） |
| 2 多分支情况 | T1（多仓调度）、T3（同名配对/unpaired）、T4（下拉标注） |
| 3 排除/仅对比特定文件或文件夹 | T2（pathspec 过滤进指纹）、T3（include/exclude 参数）、T4（过滤输入框） |
