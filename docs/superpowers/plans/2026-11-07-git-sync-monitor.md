# Git 分支同步监控站 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建本机运行的 Git 分支同步监控站：镜像克隆监听仓库变更，按提交判定各分支包含关系并标红未包含分支，SSE 实时刷新。

**Architecture:** 单进程 Fastify 服务承载后端（调度器→镜像 fetch→ref diff→SQLite 入库→REST+SSE）与 Vue 3 SPA 静态托管；平台 API/MCP 作为可插拔适配器，v1 为空实现。

**Tech Stack:** Node.js ≥20、TypeScript（strict）、Fastify 5、better-sqlite3、zod、Vue 3 + Vite 6、vitest、系统 git（spawn）。

**Spec:** `docs/superpowers/specs/2026-11-07-git-branch-sync-monitor-design.md`（下称"设计文档"；本计划按其实现，冲突时以设计文档语义为准并在任务中注明）

## Global Constraints

- Node ≥ 20，包管理器 pnpm ≥ 9（执行前 `pnpm -v` 校验）。
- TypeScript `strict: true`；后端模块系统 ESM（`"type": "module"`，相对导入带 `.js` 后缀）。
- 所有 git 调用使用 `spawn('git', args数组)`，**禁止 shell 字符串拼接**（防注入）。
- 对 git 远端**只读**：仅允许 `clone --mirror`、`fetch --prune`、读取类命令；严禁 push/reset/clean/checkout 工作区操作。
- 集成测试必须用真实 git fixture（临时目录裸仓库），**不 mock git 语义**；只有纯函数与 HTTP 层可用 mock。
- 目录约定：数据目录默认 `~/.git-sync-monitor/`（`config.json`、`monitor.db`、`repos/<repo-id>/` 镜像）；环境变量 `GSM_CONFIG`、`GSM_DATA` 可覆盖。
- 提交信息用 conventional commits（中文描述可）；每个任务结束时代码必须全绿再提交：`pnpm -C server test`（任务 11 起 plus `pnpm -C web test`）。
- 所有命令默认在仓库根 `~/code/git-sync-monitor` 执行。

## File Structure

```
git-sync-monitor/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json   # pnpm workspace 根
├── scripts/make-fixture.sh                                    # 演示/验收用 fixture 仓库生成
├── README.md
├── docs/superpowers/{specs,plans}/                            # 设计文档与本计划
├── server/
│   ├── package.json / tsconfig.json / vitest.config.ts
│   ├── src/
│   │   ├── index.ts        # 入口：读配置→buildApp→listen→信号处理
│   │   ├── app.ts          # buildApp：装配 db/scheduler/sse/api/静态托管
│   │   ├── config.ts       # zod 配置加载校验 + isBranchExcluded
│   │   ├── util/glob.ts    # gitignore 风格 glob 子集（* 与 **）
│   │   ├── gitRunner.ts    # spawn git：超时/stderr/超时 kill
│   │   ├── mirror.ts       # ensureMirror / fetchMirror / snapshotRefs
│   │   ├── refDiff.ts      # diffRefs 纯函数 + classifyChanges（祖先判定）
│   │   ├── parse.ts        # rev-list --format 解析（CommitInfo）
│   │   ├── sync.ts         # 入库/回填/分支 upsert/fetch 事件
│   │   ├── analyzer.ts     # 包含判定、ahead/behind、分支对比
│   │   ├── scheduler.ts    # 轮询循环、互斥、指数退避、损坏自愈
│   │   ├── sse.ts          # SSE hub
│   │   ├── api.ts          # REST 路由
│   │   ├── db.ts           # better-sqlite3 打开 + 迁移
│   │   └── platform/types.ts # PlatformAdapter 接口 + nullAdapter
│   └── test/               # fixture.ts + 各模块测试 + api 集成测试
└── web/
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    └── src/
        ├── main.ts / App.vue / router.ts / style.css / vite-env.d.ts
        ├── api.ts          # fetch 封装、类型、formatRelative、connectEvents
        └── views/{Overview,CommitDetail,Compare}.vue
```

---

### Task 1: 工作区脚手架与 Fastify 冒烟

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`
- Create: `server/package.json`、`server/tsconfig.json`、`server/vitest.config.ts`
- Create: `web/package.json`、`web/tsconfig.json`、`web/vite.config.ts`、`web/index.html`、`web/src/main.ts`、`web/src/App.vue`、`web/src/vite-env.d.ts`、`web/src/style.css`
- Create: `server/src/app.ts`、`server/src/index.ts`
- Test: `server/test/smoke.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `buildApp(options?): Promise<AppHandle>`（本任务为最小版：`{ app: FastifyInstance; close(): Promise<void> }`，路由 `GET /api/ping` → `{ pong: true }`；后续任务扩展 options 与返回字段）；`pnpm dev/build/start/test` 根脚本。

- [ ] **Step 1: 写入工作区配置文件**

`package.json`：

```json
{
  "name": "git-sync-monitor",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"pnpm -C server dev\" \"pnpm -C web dev\"",
    "build": "pnpm -C web build && pnpm -C server build",
    "start": "pnpm -C server start",
    "test": "pnpm -C server test && pnpm -C web test"
  },
  "devDependencies": { "concurrently": "^9.1.0" }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - server
  - web
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

`server/package.json`：

```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/static": "^8.0.3",
    "better-sqlite3": "^11.7.0",
    "fastify": "^5.2.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^3.0.2"
  }
}
```

`server/tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "types": ["node"] },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

`server/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' }
})
```

`web/package.json`：

```json
{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "@vue/test-utils": "^2.4.4",
    "jsdom": "^25.0.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.7",
    "vitest": "^3.0.2"
  }
}
```

`web/tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "test/**/*.ts"]
}
```

`web/vite.config.ts`：

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:43900' } },
  test: { environment: 'jsdom', include: ['test/**/*.test.ts'] }
})
```

`web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Git 分支同步监控</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
```

`web/src/main.ts`：

```ts
import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

createApp(App).mount('#app')
```

`web/src/App.vue`：

```vue
<template>
  <main class="app">
    <h1>Git 分支同步监控</h1>
    <p>脚手架就绪</p>
  </main>
</template>
```

`web/src/style.css`：

```css
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; margin: 0; }
.app { max-width: 1080px; margin: 0 auto; padding: 16px; }
```

- [ ] **Step 2: 安装依赖**

Run: `pnpm install`
Expected: 三个 package 安装成功（better-sqlite3 可能有原生构建输出，只要 exit code 0 即可）。

- [ ] **Step 3: 写失败测试 `server/test/smoke.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'

describe('app 冒烟', () => {
  it('GET /api/ping 返回 pong', async () => {
    const { app, close } = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: true })
    await close()
  })
})
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `Cannot find module .../src/app.js`（app.ts 尚不存在）。

- [ ] **Step 5: 最小实现 `server/src/app.ts` 与 `server/src/index.ts`**

`server/src/app.ts`：

```ts
import Fastify, { type FastifyInstance } from 'fastify'

export interface AppHandle {
  app: FastifyInstance
  close(): Promise<void>
}

export async function buildApp(): Promise<AppHandle> {
  const app = Fastify({ logger: false })
  app.get('/api/ping', async () => ({ pong: true }))
  const close = async (): Promise<void> => { await app.close() }
  return { app, close }
}
```

`server/src/index.ts`：

```ts
import { buildApp } from './app.js'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 43900)

const { app, close } = await buildApp()
await app.listen({ host, port })
console.log(`git-sync-monitor listening on http://${host}:${port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void close().then(() => process.exit(0)) })
}
```

- [ ] **Step 6: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS（1 个测试）。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "chore: pnpm workspace 脚手架与 Fastify 冒烟测试"
```

---

### Task 2: 配置加载校验与分支 glob 过滤

**Files:**
- Create: `server/src/config.ts`、`server/src/util/glob.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type RepoConfig = { id: string; url: string; defaultBranch: string; branchExclude: string[]; pollIntervalSeconds: number }`
  - `type AppConfig = { repos: RepoConfig[]; server: { host: string; port: number } }`
  - `loadConfig(path: string): AppConfig`（缺文件/非法时 throw Error）
  - `isBranchExcluded(branch: string, patterns: string[]): boolean`
  - `matchesGlob(value: string, glob: string): boolean`（支持 `*` 不跨 `/`、`**` 跨级）

- [ ] **Step 1: 写失败测试 `server/test/config.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBranchExcluded, loadConfig } from '../src/config.js'

function writeConfig(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gsm-config-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(json))
  return file
}

const valid = { repos: [{ id: 'demo', url: 'ssh://git@example.com/demo.git' }] }

describe('loadConfig', () => {
  it('解析合法配置并填充默认值', () => {
    const cfg = loadConfig(writeConfig(valid))
    expect(cfg.repos[0]).toMatchObject({ id: 'demo', defaultBranch: 'master', pollIntervalSeconds: 30, branchExclude: [] })
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 43900 })
  })
  it('缺少 url 时报错并指明字段', () => {
    expect(() => loadConfig(writeConfig({ repos: [{ id: 'demo' }] }))).toThrow(/url/)
  })
  it('配置文件不存在时报错', () => {
    expect(() => loadConfig('/nonexistent/gsm/config.json')).toThrow(/无法读取配置文件/)
  })
  it('repos 为空时报错', () => {
    expect(() => loadConfig(writeConfig({ repos: [] }))).toThrow()
  })
})

describe('isBranchExcluded', () => {
  it('支持 * 与 ** glob', () => {
    expect(isBranchExcluded('tmp/foo', ['tmp/*'])).toBe(true)
    expect(isBranchExcluded('release/x/tmp/y', ['**/tmp/*'])).toBe(true)
    expect(isBranchExcluded('master', ['tmp/*'])).toBe(false)
    expect(isBranchExcluded('release/1.0', [])).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `config.js` 模块不存在（冒烟测试仍应通过）。

- [ ] **Step 3: 实现 `server/src/util/glob.ts`**

```ts
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*')
  return new RegExp(`^${pattern}$`)
}

export function matchesGlob(value: string, glob: string): boolean {
  return globToRegExp(glob).test(value)
}
```

- [ ] **Step 4: 实现 `server/src/config.ts`**

```ts
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
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS（冒烟 + config 全部用例）。

- [ ] **Step 6: 提交**

```bash
git add server/src/config.ts server/src/util server/test/config.test.ts && git commit -m "feat: zod 配置加载校验与分支 glob 过滤"
```

---

### Task 3: GitRunner（spawn git 封装）

**Files:**
- Create: `server/src/gitRunner.ts`
- Test: `server/test/gitRunner.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `runGit(cwd: string, args: string[], opts?: { timeoutMs?: number; bin?: string }): Promise<{ stdout: string; stderr: string }>`
  - `class GitCommandError extends Error`，构造 `(args: string[], exitCode: number | null, stderr: string)`
  - 默认超时 60_000ms；超时 kill（SIGKILL）后 reject `Error('git <args> 超时 (<ms>ms)')`

- [ ] **Step 1: 写失败测试 `server/test/gitRunner.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitCommandError, runGit } from '../src/gitRunner.js'

describe('runGit', () => {
  it('执行 git --version 并返回 stdout', async () => {
    const r = await runGit(process.cwd(), ['--version'])
    expect(r.stdout).toContain('git version')
  })

  it('失败命令抛 GitCommandError 且带 stderr', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'gsm-norepo-'))
    const err = await runGit(notARepo, ['status']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
    expect((err as GitCommandError).stderr.length).toBeGreaterThan(0)
  })

  it('超时 kill 并报超时错误', async () => {
    await expect(runGit('.', ['5'], { timeoutMs: 100, bin: 'sleep' })).rejects.toThrow(/超时/)
  })

  it('大体积 CJK 输出在分块边界不损坏（Buffer 拼接后解码）', async () => {
    const bigFile = join(mkdtempSync(join(tmpdir(), 'gsm-cjk-')), 'big.txt')
    const content = Array.from({ length: 20_000 }, (_, i) => `第${i}行：中文提交主题测试，多字节UTF8。`).join('\n')
    writeFileSync(bigFile, content, 'utf8')
    const r = await runGit('.', [bigFile], { bin: 'cat' })
    expect(r.stdout).toBe(content)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `gitRunner.js` 不存在。

- [ ] **Step 3: 实现 `server/src/gitRunner.ts`**

```ts
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
      // 先拼 Buffer 再解码：避免多字节 UTF-8 在管道分块边界被截断损坏
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (timedOut) reject(new Error(`${bin} ${args.join(' ')} 超时 (${timeoutMs}ms)`))
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new GitCommandError(args, code, stderr))
    })
  })
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/gitRunner.ts server/test/gitRunner.test.ts && git commit -m "feat: GitRunner spawn git 封装（超时/stderr/注入安全）"
```

---

### Task 4: 镜像管理与测试 fixture 助手

**Files:**
- Create: `server/src/mirror.ts`、`server/test/fixture.ts`
- Test: `server/test/mirror.test.ts`

**Interfaces:**
- Consumes: `runGit`（Task 3）
- Produces:
  - `type RefSnapshot = { [branch: string]: string }`（分支名 → commit sha）
  - `ensureMirror(url: string, dir: string): Promise<'cloned' | 'existing'>`（dir 不存在时 `clone --mirror`，父目录自动创建）
  - `fetchMirror(dir: string): Promise<void>`（`fetch --prune origin`）
  - `snapshotRefs(dir: string): Promise<RefSnapshot>`（`for-each-ref refs/heads --format=%(refname:short)%09%(objectname)`）
  - 测试助手 `createOriginRepo(prefix?): OriginRepo`：`{ dir, git(args), commitFile(name, content) → sha }`（初始分支 master，user=Tester）

- [ ] **Step 1: 写测试助手 `server/test/fixture.ts`**

```ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface OriginRepo {
  dir: string
  git(args: string[]): void
  commitFile(name: string, content: string): string
}

export function createOriginRepo(prefix = 'gsm-origin-'): OriginRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const git = (args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} 失败: ${r.stderr}`)
  }
  git(['init', '--initial-branch=master'])
  git(['config', 'user.name', 'Tester'])
  git(['config', 'user.email', 'tester@example.com'])
  const commitFile = (name: string, content: string): string => {
    writeFileSync(join(dir, name), content)
    git(['add', name])
    git(['commit', '-m', `add ${name}`])
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  }
  commitFile('README.md', '# demo\n')
  return { dir, git, commitFile }
}
```

- [ ] **Step 2: 写失败测试 `server/test/mirror.test.ts`**

```ts
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
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `mirror.js` 不存在。

- [ ] **Step 4: 实现 `server/src/mirror.ts`**

```ts
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
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add server/src/mirror.ts server/test/fixture.ts server/test/mirror.test.ts && git commit -m "feat: 镜像克隆/fetch/引用快照与测试 fixture 助手"
```

---

### Task 5: refDiff（快照差异四情形）

**Files:**
- Create: `server/src/refDiff.ts`
- Test: `server/test/refDiff.test.ts`

**Interfaces:**
- Consumes: `RefSnapshot`（Task 4）、`runGit`（Task 3）
- Produces:
  - `type RawChange = { type: 'added'; branch; newSha } | { type: 'updated'; branch; oldSha; newSha } | { type: 'deleted'; branch; oldSha }`
  - `type RefChange = RawChange 的 updated 细化为 { type: 'fast-forward' | 'force-push' } 后的联合`
  - `diffRefs(before: RefSnapshot, after: RefSnapshot): RawChange[]`（纯函数）
  - `classifyChange(mirrorDir: string, change: RawChange): Promise<RefChange>`（updated 用 `merge-base --is-ancestor old new`：0 → fast-forward，否则 force-push）
  - `classifyChanges(mirrorDir: string, changes: RawChange[]): Promise<RefChange[]>`（顺序执行）

- [ ] **Step 1: 写失败测试 `server/test/refDiff.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { diffRefs } from '../src/refDiff.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyChange } from '../src/refDiff.js'

describe('diffRefs 纯函数', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)

  it('新分支', () => {
    expect(diffRefs({}, { master: A })).toEqual([{ type: 'added', branch: 'master', newSha: A }])
  })
  it('更新', () => {
    expect(diffRefs({ master: A }, { master: B })).toEqual([{ type: 'updated', branch: 'master', oldSha: A, newSha: B }])
  })
  it('删除', () => {
    expect(diffRefs({ side: A }, {})).toEqual([{ type: 'deleted', branch: 'side', oldSha: A }])
  })
  it('无变化', () => {
    expect(diffRefs({ master: A }, { master: A })).toEqual([])
  })
})

describe('classifyChange（真实 git）', () => {
  it('后代提交判为 fast-forward', async () => {
    const origin = createOriginRepo()
    const oldSha = origin.commitFile('a.txt', '1')
    const newSha = origin.commitFile('b.txt', '2')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const c = await classifyChange(mirrorDir, { type: 'updated', branch: 'master', oldSha, newSha })
    expect(c).toEqual({ type: 'fast-forward', branch: 'master', oldSha, newSha })
  })

  it('历史重写判为 force-push', async () => {
    const origin = createOriginRepo()
    const oldSha = origin.commitFile('a.txt', '1')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    origin.git(['commit', '--amend', '--no-edit', '--allow-empty'])  // 镜像克隆后重写历史
    const amended = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: origin.dir, encoding: 'utf8' }).stdout.trim()
    const c = await classifyChange(mirrorDir, { type: 'updated', branch: 'master', oldSha, newSha: amended })
    expect(c).toEqual({ type: 'force-push', branch: 'master', oldSha, newSha: amended })
  })
})
```

（顶部 import 需含 `spawnSync`：`import { spawnSync } from 'node:child_process'`。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `refDiff.js` 不存在。

- [ ] **Step 3: 实现 `server/src/refDiff.ts`**

```ts
import { runGit } from './gitRunner.js'
import type { RefSnapshot } from './mirror.js'

export type RawChange =
  | { type: 'added'; branch: string; newSha: string }
  | { type: 'updated'; branch: string; oldSha: string; newSha: string }
  | { type: 'deleted'; branch: string; oldSha: string }

export type RefChange =
  | { type: 'added'; branch: string; newSha: string }
  | { type: 'fast-forward'; branch: string; oldSha: string; newSha: string }
  | { type: 'force-push'; branch: string; oldSha: string; newSha: string }
  | { type: 'deleted'; branch: string; oldSha: string }

export function diffRefs(before: RefSnapshot, after: RefSnapshot): RawChange[] {
  const changes: RawChange[] = []
  for (const [branch, newSha] of Object.entries(after)) {
    const oldSha = before[branch]
    if (!oldSha) changes.push({ type: 'added', branch, newSha })
    else if (oldSha !== newSha) changes.push({ type: 'updated', branch, oldSha, newSha })
  }
  for (const [branch, oldSha] of Object.entries(before)) {
    if (!(branch in after)) changes.push({ type: 'deleted', branch, oldSha })
  }
  return changes
}

export async function classifyChange(mirrorDir: string, change: RawChange): Promise<RefChange> {
  if (change.type !== 'updated') return change
  const ok = await runGit(mirrorDir, ['merge-base', '--is-ancestor', change.oldSha, change.newSha])
    .then(() => true)
    .catch(() => false)
  return ok
    ? { type: 'fast-forward', branch: change.branch, oldSha: change.oldSha, newSha: change.newSha }
    : { type: 'force-push', branch: change.branch, oldSha: change.oldSha, newSha: change.newSha }
}

export async function classifyChanges(mirrorDir: string, changes: RawChange[]): Promise<RefChange[]> {
  const out: RefChange[] = []
  for (const c of changes) out.push(await classifyChange(mirrorDir, c))
  return out
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/refDiff.ts server/test/refDiff.test.ts && git commit -m "feat: 引用快照 diff 与 fast-forward/force-push 祖先判定"
```

---

### Task 6: SQLite 打开与迁移

**Files:**
- Create: `server/src/db.ts`
- Test: `server/test/db.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `openDb(dbPath: string): Database.Database`（自动建父目录、WAL、foreign_keys=ON、按 `user_version` 迁移到 v1；表结构 = 设计文档 §6，逐字如下）

- [ ] **Step 1: 写失败测试 `server/test/db.test.ts`**

```ts
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'

describe('openDb', () => {
  it('建库并创建全部表', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name)
    for (const t of ['repos', 'branches', 'commits', 'fetch_events']) expect(tables).toContain(t)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    db.close()
  })

  it('commits 与 branches 唯一约束生效', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'u', 1)`).run()
    db.prepare(`INSERT INTO branches (repo_id, name, created_at, updated_at) VALUES ('r', 'master', 1, 1)`).run()
    expect(() => db.prepare(`INSERT INTO branches (repo_id, name, created_at, updated_at) VALUES ('r', 'master', 2, 2)`).run()).toThrow(/UNIQUE/)
    db.prepare(`INSERT INTO commits (repo_id, sha, committed_at, first_seen_at) VALUES ('r', 'abc', 1, 1)`).run()
    expect(() => db.prepare(`INSERT INTO commits (repo_id, sha, committed_at, first_seen_at) VALUES ('r', 'abc', 2, 2)`).run()).toThrow(/UNIQUE/)
    db.close()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `db.js` 不存在。

- [ ] **Step 3: 实现 `server/src/db.ts`**

```ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_V1 = `
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  default_branch TEXT,
  created_at    INTEGER NOT NULL
);
CREATE TABLE branches (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  name          TEXT NOT NULL,
  head_sha      TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  rewritten_at  INTEGER,
  last_commit_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(repo_id, name)
);
CREATE TABLE commits (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  sha           TEXT NOT NULL,
  author_name   TEXT,
  author_email  TEXT,
  committed_at  INTEGER NOT NULL,
  subject       TEXT,
  body          TEXT,
  first_seen_branch TEXT,
  first_seen_at INTEGER NOT NULL,
  UNIQUE(repo_id, sha)
);
CREATE TABLE fetch_events (
  id            INTEGER PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  new_commits   INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
`

function migrate(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0
  if (version < 1) {
    db.exec(SCHEMA_V1)
    db.pragma('user_version = 1')
  }
}

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/db.ts server/test/db.test.ts && git commit -m "feat: SQLite 打开与 v1 迁移（repos/branches/commits/fetch_events）"
```

---

### Task 7: 提交解析与同步入库

**Files:**
- Create: `server/src/parse.ts`、`server/src/sync.ts`
- Test: `server/test/parse.test.ts`、`server/test/sync.test.ts`

**Interfaces:**
- Consumes: `runGit`（T3）、`RefChange`（T5）、表结构（T6）
- Produces:
  - `type CommitInfo = { sha; authorName; authorEmail; committedAt; subject; body }`
  - `REVLIST_FORMAT = '--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e'`
  - `parseRevList(raw: string): CommitInfo[]`
  - `listCommits(mirrorDir, range: string, opts?: { maxCount?: number; skip?: number }): Promise<CommitInfo[]>`
  - `insertCommits(db, repoId, branch, commits): CommitInfo[]`（INSERT OR IGNORE，返回**新插入**的）
  - `upsertBranch(db, repoId, name, sha)` / `markBranchDeleted(db, repoId, name)`
  - `backfillRepo(db, repoId, mirrorDir, heads: {branch; sha}[]): Promise<number>`（逐分支全量，入库但不产生事件——事件由调用方负责）
  - `applyChanges(db, repoId, mirrorDir, changes: RefChange[]): Promise<{ newCommits: number; insertedByBranch: Record<string, CommitInfo[]> }>`
  - `startFetchEvent(db, repoId): number` / `finishFetchEvent(db, id, status: 'ok'|'failed', newCommits, error?)`

- [ ] **Step 1: 写失败测试 `server/test/parse.test.ts`**

```ts
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
```

- [ ] **Step 2: 写失败测试 `server/test/sync.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { openDb } from '../src/db.js'
import { applyChanges, backfillRepo, finishFetchEvent, insertCommits, startFetchEvent } from '../src/sync.js'
import { listCommits } from '../src/sync.js'
import { diffRefs, classifyChanges } from '../src/refDiff.js'
import { snapshotRefs } from '../src/mirror.js'
import type Database from 'better-sqlite3'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}
function count(db: Database.Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n
}

describe('sync（真实 git fixture）', () => {
  it('backfillRepo 全量入库且分支建行', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.commitFile('r.txt', 'r1')
    origin.git(['checkout', 'master'])
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()

    const snap = await snapshotRefs(mirrorDir)
    const heads = Object.entries(snap).map(([branch, sha]) => ({ branch, sha }))
    const total = await backfillRepo(db, 'r', mirrorDir, heads)
    expect(total).toBe(2)
    expect(count(db, `SELECT COUNT(*) AS n FROM branches WHERE repo_id='r'`)).toBe(2)
    db.close()
  })

  it('fast-forward 增量只插入新提交', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
    await backfillRepo(db, 'r', mirrorDir, [{ branch: 'master', sha: headSha(origin.dir) }])

    const oldSha = headSha(origin.dir)
    origin.commitFile('n.txt', 'new')
    const newSha = headSha(origin.dir)
    const changes = await classifyChanges(mirrorDir, diffRefs({ master: oldSha }, { master: newSha }))
    const r = await applyChanges(db, 'r', mirrorDir, changes)
    expect(r.newCommits).toBe(1)
    expect(r.insertedByBranch['master']).toHaveLength(1)
    expect(count(db, `SELECT COUNT(*) AS n FROM commits WHERE repo_id='r'`)).toBe(2)
    db.close()
  })

  it('force-push 更新 head 并标记 rewritten；deleted 标记状态', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
    await backfillRepo(db, 'r', mirrorDir, [{ branch: 'master', sha: headSha(origin.dir) }])

    const oldSha = headSha(origin.dir)
    origin.git(['commit', '--amend', '--no-edit'])
    const amended = headSha(origin.dir)
    const changes = await classifyChanges(mirrorDir, diffRefs({ master: oldSha }, { master: amended }))
    await applyChanges(db, 'r', mirrorDir, changes)
    const row = db.prepare(`SELECT head_sha, rewritten_at FROM branches WHERE repo_id='r' AND name='master'`).get() as { head_sha: string; rewritten_at: number | null }
    expect(row.head_sha).toBe(amended)
    expect(row.rewritten_at).not.toBeNull()

    const evId = startFetchEvent(db, 'r')
    finishFetchEvent(db, evId, 'ok', 0)
    expect((db.prepare(`SELECT status FROM fetch_events WHERE id=?`).get(evId) as { status: string }).status).toBe('ok')

    await applyChanges(db, 'r', mirrorDir, [{ type: 'deleted', branch: 'master', oldSha: amended }])
    expect((db.prepare(`SELECT status FROM branches WHERE repo_id='r' AND name='master'`).get() as { status: string }).status).toBe('deleted')
    db.close()
  })

  it('listCommits 支持 maxCount/skip 且 insertCommits 幂等', async () => {
    const origin = createOriginRepo()
    origin.commitFile('a.txt', '1')
    origin.commitFile('b.txt', '2')
    origin.commitFile('c.txt', '3')
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
    db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()

    const page = await listCommits(mirrorDir, 'refs/heads/master', { maxCount: 2 })
    expect(page).toHaveLength(2)
    const all = await listCommits(mirrorDir, 'refs/heads/master')
    expect(all).toHaveLength(4) // fixture 初始 README 提交 + 3
    const again = insertCommits(db, 'r', 'master', all)
    expect(again).toHaveLength(4)
    expect(insertCommits(db, 'r', 'master', all)).toHaveLength(0) // 幂等
    db.close()
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `parse.js`/`sync.js` 不存在。

- [ ] **Step 4: 实现 `server/src/parse.ts`**

```ts
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
```

- [ ] **Step 5: 实现 `server/src/sync.ts`**

```ts
import type Database from 'better-sqlite3'
import { runGit } from './gitRunner.js'
import { REVLIST_FORMAT, parseRevList, type CommitInfo } from './parse.js'
import type { RefChange } from './refDiff.js'

export function listCommits(
  mirrorDir: string, range: string, opts: { maxCount?: number; skip?: number } = {}
): Promise<CommitInfo[]> {
  const args = ['rev-list', range]
  if (opts.skip) args.push('--skip', String(opts.skip))
  if (opts.maxCount) args.push('--max-count', String(opts.maxCount))
  args.push(REVLIST_FORMAT)
  return runGit(mirrorDir, args).then(r => parseRevList(r.stdout))
}

export function insertCommits(db: Database.Database, repoId: string, branch: string, commits: CommitInfo[]): CommitInfo[] {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO commits
     (repo_id, sha, author_name, author_email, committed_at, subject, body, first_seen_branch, first_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  const inserted: CommitInfo[] = []
  db.transaction((list: CommitInfo[]) => {
    for (const c of list) {
      const r = stmt.run(repoId, c.sha, c.authorName, c.authorEmail, c.committedAt, c.subject, c.body, branch, now)
      if (r.changes > 0) inserted.push(c)
    }
  })(commits)
  return inserted
}

export function upsertBranch(db: Database.Database, repoId: string, name: string, sha: string): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO branches (repo_id, name, head_sha, status, created_at, updated_at)
     VALUES (?,?,?,'active',?,?)
     ON CONFLICT(repo_id, name) DO UPDATE SET
       head_sha = excluded.head_sha, updated_at = excluded.updated_at, status = 'active'`
  ).run(repoId, name, sha, now, now)
}

export function markBranchDeleted(db: Database.Database, repoId: string, name: string): void {
  db.prepare(`UPDATE branches SET status='deleted', updated_at=? WHERE repo_id=? AND name=?`)
    .run(Date.now(), repoId, name)
}

export async function backfillRepo(
  db: Database.Database, repoId: string, mirrorDir: string, heads: { branch: string; sha: string }[]
): Promise<number> {
  let total = 0
  for (const { branch, sha } of heads) {
    const commits = await listCommits(mirrorDir, sha)
    total += insertCommits(db, repoId, branch, commits).length
    upsertBranch(db, repoId, branch, sha)
  }
  return total
}

export interface ApplyResult {
  newCommits: number
  insertedByBranch: Record<string, CommitInfo[]>
}

export async function applyChanges(
  db: Database.Database, repoId: string, mirrorDir: string, changes: RefChange[]
): Promise<ApplyResult> {
  const insertedByBranch: Record<string, CommitInfo[]> = {}
  let newCommits = 0
  for (const ch of changes) {
    if (ch.type === 'added') {
      const inserted = insertCommits(db, repoId, ch.branch, await listCommits(mirrorDir, ch.newSha))
      upsertBranch(db, repoId, ch.branch, ch.newSha)
      insertedByBranch[ch.branch] = inserted
      newCommits += inserted.length
    } else if (ch.type === 'fast-forward') {
      const inserted = insertCommits(db, repoId, ch.branch, await listCommits(mirrorDir, `${ch.oldSha}..${ch.newSha}`))
      upsertBranch(db, repoId, ch.branch, ch.newSha)
      insertedByBranch[ch.branch] = inserted
      newCommits += inserted.length
    } else if (ch.type === 'force-push') {
      db.prepare(`UPDATE branches SET head_sha=?, rewritten_at=?, updated_at=? WHERE repo_id=? AND name=?`)
        .run(ch.newSha, Date.now(), Date.now(), repoId, ch.branch)
    } else {
      markBranchDeleted(db, repoId, ch.branch)
    }
  }
  return { newCommits, insertedByBranch }
}

export function startFetchEvent(db: Database.Database, repoId: string): number {
  const r = db.prepare(`INSERT INTO fetch_events (repo_id, started_at, status) VALUES (?,?, 'running')`).run(repoId, Date.now())
  return Number(r.lastInsertRowid)
}

export function finishFetchEvent(
  db: Database.Database, id: number, status: 'ok' | 'failed', newCommits = 0, error: string | null = null
): void {
  db.prepare(`UPDATE fetch_events SET finished_at=?, status=?, new_commits=?, error=? WHERE id=?`)
    .run(Date.now(), status, newCommits, error, id)
}
```

- [ ] **Step 6: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add server/src/parse.ts server/src/sync.ts server/test/parse.test.ts server/test/sync.test.ts && git commit -m "feat: rev-list 解析与同步入库（回填/增量/重写/删除/fetch 事件）"
```

---

### Task 8: Analyzer（包含判定与分支对比）

**Files:**
- Create: `server/src/analyzer.ts`
- Test: `server/test/analyzer.test.ts`

**Interfaces:**
- Consumes: `runGit`（T3）、`listCommits`（T7）、`CommitInfo`（T7）
- Produces:
  - `type BranchStatus = 'active' | 'deleted' | 'rewritten'`
  - `type BranchInclusion = { branch: string; contains: boolean; status: BranchStatus }`
  - `inclusionForCommit(mirrorDir, sha, branches: { name: string; status: BranchStatus }[]): Promise<BranchInclusion[]>`（一条 `branch --contains --format=%(refname:short)` 批量判定；sha 未知时抛 GitCommandError）
  - `aheadBehind(mirrorDir, base, target): Promise<{ ahead: number; behind: number }>`（ahead = base 独有，behind = target 独有）
  - `compareBranches(mirrorDir, base, target): Promise<{ ahead; behind; aheadCommits: CommitInfo[]; behindCommits: CommitInfo[] }>`（aheadCommits = `target..base`，behindCommits = `base..target`）

- [ ] **Step 1: 写失败测试 `server/test/analyzer.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { ensureMirror } from '../src/mirror.js'
import { aheadBehind, compareBranches, inclusionForCommit } from '../src/analyzer.js'
import { GitCommandError } from '../src/gitRunner.js'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}

describe('inclusionForCommit', () => {
  it('合并传播为包含；cherry-pick（不同 sha）判定为未包含（锁定 §3.3 语义）', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.git(['checkout', 'master'])
    const fixSha = origin.commitFile('fix.txt', 'fix')           // master 新提交
    origin.git(['checkout', 'release/1.0'])
    origin.git(['merge', 'master', '--no-edit'])                  // 合并 → 包含 fixSha
    origin.git(['checkout', 'master'])
    origin.commitFile('next.txt', 'n')                            // master 又前进
    origin.git(['checkout', '-b', 'cherry-side', 'master~2'])     // 基于 fixSha 之前的提交
    origin.git(['cherry-pick', fixSha])                           // cherry-pick → 新 sha
    origin.git(['checkout', 'master'])

    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)

    const branches = [
      { name: 'master', status: 'active' as const },
      { name: 'release/1.0', status: 'active' as const },
      { name: 'cherry-side', status: 'active' as const },
      { name: 'gone', status: 'deleted' as const }
    ]
    const results = await inclusionForCommit(mirrorDir, fixSha, branches)
    const byName = Object.fromEntries(results.map(r => [r.branch, r]))
    expect(byName['master']).toEqual({ branch: 'master', contains: true, status: 'active' })
    expect(byName['release/1.0'].contains).toBe(true)
    expect(byName['cherry-side'].contains).toBe(false)  // 核心语义：cherry-pick ≠ 包含
    expect(byName['gone']).toEqual({ branch: 'gone', contains: false, status: 'deleted' })
  })

  it('未知 sha 抛 GitCommandError', async () => {
    const origin = createOriginRepo()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    const err = await inclusionForCommit(mirrorDir, 'f'.repeat(40), [{ name: 'master', status: 'active' }])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitCommandError)
  })
})

describe('aheadBehind / compareBranches', () => {
  it('ahead=base 独有，behind=target 独有', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'dev'])
    origin.commitFile('d1.txt', '1')
    origin.commitFile('d2.txt', '2')
    origin.git(['checkout', 'master'])
    origin.commitFile('m1.txt', '1')

    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    await ensureMirror(origin.dir, mirrorDir)
    expect(await aheadBehind(mirrorDir, 'dev', 'master')).toEqual({ ahead: 2, behind: 1 })

    const cmp = await compareBranches(mirrorDir, 'dev', 'master')
    expect(cmp.aheadCommits.map(c => c.subject).sort()).toEqual(['add d1.txt', 'add d2.txt'])
    expect(cmp.behindCommits.map(c => c.subject)).toEqual(['add m1.txt'])
    void headSha
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `analyzer.js` 不存在。

- [ ] **Step 3: 实现 `server/src/analyzer.ts`**

```ts
import { runGit } from './gitRunner.js'
import { listCommits } from './sync.js'
import type { CommitInfo } from './parse.js'

export type BranchStatus = 'active' | 'deleted' | 'rewritten'

export interface BranchInclusion { branch: string; contains: boolean; status: BranchStatus }

export interface InclusionBranch { name: string; status: BranchStatus }

export async function inclusionForCommit(
  mirrorDir: string, sha: string, branches: InclusionBranch[]
): Promise<BranchInclusion[]> {
  const { stdout } = await runGit(mirrorDir, ['branch', '--contains', sha, '--format=%(refname:short)'])
  const containing = new Set(stdout.split('\n').filter(Boolean))
  return branches.map(b => ({ branch: b.name, contains: containing.has(b.name), status: b.status }))
}

export async function aheadBehind(
  mirrorDir: string, base: string, target: string
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await runGit(mirrorDir, [
    'rev-list', '--left-right', '--count', `refs/heads/${base}...refs/heads/${target}`
  ])
  const [left, right] = stdout.trim().split('\t').map(Number)
  return { ahead: left ?? 0, behind: right ?? 0 }
}

export interface CompareResult {
  ahead: number
  behind: number
  aheadCommits: CommitInfo[]
  behindCommits: CommitInfo[]
}

export async function compareBranches(
  mirrorDir: string, base: string, target: string
): Promise<CompareResult> {
  const [ab, aheadCommits, behindCommits] = await Promise.all([
    aheadBehind(mirrorDir, base, target),
    listCommits(mirrorDir, `refs/heads/${target}..refs/heads/${base}`),
    listCommits(mirrorDir, `refs/heads/${base}..refs/heads/${target}`)
  ])
  return { ahead: ab.ahead, behind: ab.behind, aheadCommits, behindCommits }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS（注意 cherry-pick 用例锁定了设计文档 §3.3 语义）。

- [ ] **Step 5: 提交**

```bash
git add server/src/analyzer.ts server/test/analyzer.test.ts && git commit -m "feat: 包含判定与分支对比（含 cherry-pick≠包含语义测试）"
```

---

### Task 9: Scheduler（轮询/退避/锁/损坏自愈）

**Files:**
- Create: `server/src/scheduler.ts`
- Test: `server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `ensureMirror/fetchMirror/snapshotRefs`（T4）、`diffRefs/classifyChanges`（T5）、`applyChanges/backfillRepo/startFetchEvent/finishFetchEvent`（T7）、`isBranchExcluded`（T2）、`RepoConfig`（T2）
- Produces:
  - `type SchedulerStatus = { state: 'starting'|'running'|'idle'|'backoff'; lastRunAt: number|null; nextRunAt: number|null; consecutiveFailures: number; lastError: string|null; lastNewCommits: number|null }`
  - `nextBackoffMs(attempt: number): number`（5s×2^(n-1)，上限 5min）
  - `type SchedulerHandlers = { onCommitsNew(branch, commits: CommitInfo[]): void; onBranchesUpdated(): void; onStatus(s: SchedulerStatus): void }`
  - `new Scheduler({ db, repo, mirrorDir, handlers })`；`start()`/`stop()`；`runOnce(): Promise<{ skipped: boolean } & ({ newCommits: number } | { error: string } | {})>`
  - 语义：`branches` 表为空时首次运行走全量回填（**不**触发 onCommitsNew，设计文档 §5.4）；fetch 报仓库损坏时删除镜像目录，下一轮自动重克隆

- [ ] **Step 1: 写失败测试 `server/test/scheduler.test.ts`**

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { openDb } from '../src/db.js'
import { Scheduler, nextBackoffMs } from '../src/scheduler.js'
import type { CommitInfo } from '../src/parse.js'
import type Database from 'better-sqlite3'

function headSha(dir: string): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
}
function makeScheduler(db: Database.Database, repoUrl: string, mirrorDir: string) {
  const onCommitsNew = vi.fn()
  const onBranchesUpdated = vi.fn()
  const onStatus = vi.fn()
  const s = new Scheduler({
    db,
    repo: { id: 'r', url: repoUrl, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 },
    mirrorDir,
    handlers: { onCommitsNew, onBranchesUpdated, onStatus }
  })
  return { s, onCommitsNew, onBranchesUpdated, onStatus }
}
function setupDb(): Database.Database {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gsm-db-')), 'monitor.db'))
  db.prepare(`INSERT INTO repos (id, url, created_at) VALUES ('r', 'x', 1)`).run()
  return db
}

describe('nextBackoffMs', () => {
  it('指数退避并封顶 5 分钟', () => {
    expect(nextBackoffMs(1)).toBe(5000)
    expect(nextBackoffMs(2)).toBe(10000)
    expect(nextBackoffMs(5)).toBe(80000)
    expect(nextBackoffMs(20)).toBe(300000)
  })
})

describe('Scheduler.runOnce（真实 git fixture）', () => {
  it('首次运行全量回填且不触发 onCommitsNew', async () => {
    const origin = createOriginRepo()
    origin.git(['checkout', '-b', 'rel'])
    origin.commitFile('r.txt', '1')
    origin.git(['checkout', 'master'])
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s, onCommitsNew } = makeScheduler(db, origin.dir, mirrorDir)
    const r = await s.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(2)
    expect(onCommitsNew).not.toHaveBeenCalled()
    expect(s.status.state).toBe('idle')
    db.close()
  })

  it('新提交触发增量与 onCommitsNew', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s, onCommitsNew } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    origin.commitFile('new.txt', 'n')
    const r = await s.runOnce()
    expect('newCommits' in r && r.newCommits).toBe(1)
    expect(onCommitsNew).toHaveBeenCalledTimes(1)
    expect(onCommitsNew.mock.calls[0][0]).toBe('master')
    expect((onCommitsNew.mock.calls[0][1] as CommitInfo[])[0].sha).toBe(headSha(origin.dir))
    db.close()
  })

  it('远端不可达进入退避并记录 fetch_events=failed', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    rmSync(origin.dir, { recursive: true, force: true })   // 远端消失
    const r = await s.runOnce()
    expect('error' in r).toBe(true)
    expect(s.status.consecutiveFailures).toBe(1)
    expect(['backoff', 'error']).toContain(s.status.state)
    const ev = db.prepare(`SELECT status, error FROM fetch_events ORDER BY id DESC LIMIT 1`).get() as { status: string; error: string | null }
    expect(ev.status).toBe('failed')
    expect(ev.error).not.toBeNull()
    db.close()
  })

  it('镜像损坏后自愈（重克隆）', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    await s.runOnce()

    rmSync(join(mirrorDir, 'HEAD'))   // 破坏镜像
    await s.runOnce()                  // 失败并删除镜像
    const r = await s.runOnce()        // 重克隆 + 空差异，不再回填（branches 已有行）
    expect('error' in r).toBe(false)
    expect(s.status.state).toBe('idle')
    db.close()
  })

  it('运行中重入直接跳过', async () => {
    const origin = createOriginRepo()
    const db = setupDb()
    const mirrorDir = join(mkdtempSync(join(tmpdir(), 'gsm-mirror-')), 'mirror.git')
    const { s } = makeScheduler(db, origin.dir, mirrorDir)
    // @ts-expect-error 直接操纵私有标志模拟运行中
    s.running = true
    const r = await s.runOnce()
    expect(r.skipped).toBe(true)
    // @ts-expect-error 恢复
    s.running = false
    db.close()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -C server test`
Expected: FAIL —— `scheduler.js` 不存在。

- [ ] **Step 3: 实现 `server/src/scheduler.ts`**

```ts
import { rmSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { isBranchExcluded, type RepoConfig } from './config.js'
import { ensureMirror, fetchMirror, snapshotRefs } from './mirror.js'
import { diffRefs, classifyChanges } from './refDiff.js'
import { applyChanges, backfillRepo, finishFetchEvent, startFetchEvent } from './sync.js'
import type { CommitInfo } from './parse.js'

export type SchedulerState = 'starting' | 'running' | 'idle' | 'backoff'

export interface SchedulerStatus {
  state: SchedulerState
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveFailures: number
  lastError: string | null
  lastNewCommits: number | null
}

export interface SchedulerHandlers {
  onCommitsNew(branch: string, commits: CommitInfo[]): void
  onBranchesUpdated(): void
  onStatus(s: SchedulerStatus): void
}

export interface SchedulerDeps {
  db: Database.Database
  repo: RepoConfig
  mirrorDir: string
  handlers: SchedulerHandlers
}

export function nextBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000)
}

export interface RunOnceResult { skipped: boolean; newCommits?: number; error?: string }

const CORRUPT_RE = /corrupt|not a git repository|does not appear to be a git repository/i

export class Scheduler {
  status: SchedulerStatus = {
    state: 'starting', lastRunAt: null, nextRunAt: null,
    consecutiveFailures: 0, lastError: null, lastNewCommits: null
  }
  private timer: NodeJS.Timeout | null = null
  running = false

  constructor(private deps: SchedulerDeps) {}

  start(): void { void this.loop() }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async loop(): Promise<void> {
    await this.runOnce()
    const delay = this.status.consecutiveFailures > 0
      ? nextBackoffMs(this.status.consecutiveFailures)
      : this.deps.repo.pollIntervalSeconds * 1000
    this.timer = setTimeout(() => void this.loop(), delay)
    this.setStatus({ ...this.status, nextRunAt: Date.now() + delay })
  }

  private branchCount(): number {
    return (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM branches WHERE repo_id=?`)
      .get(this.deps.repo.id) as { n: number }).n
  }

  private setStatus(s: SchedulerStatus): void {
    this.status = s
    this.deps.handlers.onStatus(s)
  }

  async runOnce(): Promise<RunOnceResult> {
    if (this.running) return { skipped: true }
    this.running = true
    this.setStatus({ ...this.status, state: 'running' })
    const { db, repo, mirrorDir } = this.deps
    const eventId = startFetchEvent(db, repo.id)
    try {
      await ensureMirror(repo.url, mirrorDir)
      const before = await snapshotRefs(mirrorDir)
      await fetchMirror(mirrorDir)
      const after = await snapshotRefs(mirrorDir)

      let newCommits = 0
      if (this.branchCount() === 0) {
        // 设计文档 §5.4：首次全量回填，不产生新提交事件
        const heads = Object.entries(after)
          .filter(([b]) => !isBranchExcluded(b, repo.branchExclude))
          .map(([branch, sha]) => ({ branch, sha }))
        newCommits = await backfillRepo(db, repo.id, mirrorDir, heads)
      } else {
        const raw = diffRefs(before, after)
          .filter(c => !isBranchExcluded(c.branch, repo.branchExclude))
        const changes = await classifyChanges(mirrorDir, raw)
        const r = await applyChanges(db, repo.id, mirrorDir, changes)
        newCommits = r.newCommits
        for (const [branch, commits] of Object.entries(r.insertedByBranch)) {
          if (commits.length > 0) this.deps.handlers.onCommitsNew(branch, commits)
        }
        if (changes.some(c => c.type === 'added' || c.type === 'deleted' || c.type === 'force-push')) {
          this.deps.handlers.onBranchesUpdated()
        }
      }
      finishFetchEvent(db, eventId, 'ok', newCommits)
      this.setStatus({
        ...this.status, state: 'idle', lastRunAt: Date.now(),
        consecutiveFailures: 0, lastError: null, lastNewCommits: newCommits
      })
      return { skipped: false, newCommits }
    } catch (e) {
      const msg = (e as Error).message
      if (CORRUPT_RE.test(msg)) rmSync(mirrorDir, { recursive: true, force: true })  // 下一轮自动重克隆
      finishFetchEvent(db, eventId, 'failed', 0, msg)
      this.setStatus({
        ...this.status, state: 'backoff', lastRunAt: Date.now(),
        consecutiveFailures: this.status.consecutiveFailures + 1, lastError: msg
      })
      return { skipped: false, error: msg }
    } finally {
      this.running = false
    }
  }
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm -C server test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/scheduler.ts server/test/scheduler.test.ts && git commit -m "feat: 轮询调度器（互斥/指数退避/回填触发/损坏自愈）"
```

---

### Task 10: SSE + REST API + 平台适配器 + 完整装配

**Files:**
- Create: `server/src/platform/types.ts`、`server/src/sse.ts`、`server/src/api.ts`
- Modify: `server/src/app.ts`（完整 buildApp）、`server/src/index.ts`（读配置启动）、`server/test/smoke.test.ts`（适配新签名）
- Test: `server/test/sse.test.ts`、`server/test/api.test.ts`

**Interfaces:**
- Consumes: T2-T9 全部模块
- Produces:
  - `type PlatformMeta = { mrTitle?: string; mrUrl?: string }`、`type PlatformEvent = { type: string; payload?: unknown }`
  - `interface PlatformAdapter { enrichCommit?(sha): Promise<PlatformMeta | null>; subscribe?(onEvent): () => void }`；`const nullAdapter: PlatformAdapter = {}`
  - `createSseHub(): SseHub`，`SseHub = { add(reply: FastifyReply): void; publish(event: string, data: unknown): void; clientCount(): number }`
  - `registerApi(app, deps: ApiDeps)`，`ApiDeps = { config; db; mirrorDirFor(repoId): string; scheduler; sse; adapter }`
  - 完整 `buildApp(options: AppOptions): Promise<AppHandle>`，`AppOptions = { configPath?; dataDir?; configOverride?: AppConfig; adapter?: PlatformAdapter }`；`AppHandle = { app; config; scheduler; sse; close() }`（buildApp **不**自动 start 调度器，由 index.ts 启动）
  - REST 端点（设计文档 §8，一处偏差已注明）：
    - `GET /api/status` → SchedulerStatus + `{ mirrorDir, lastFetch }`
    - `GET /api/repos` → `[{ id, url, defaultBranch, pollIntervalSeconds }]`
    - `GET /api/branches` → 全部分支行（含 deleted，UI 自行分组）
    - `GET /api/commits?branch=X&limit=50&offset=0` → `CommitRow[]`（**偏差说明**：设计文档写 `/api/branches/:name/commits`，因分支名可含 `/` 会破坏路径参数，改用查询参数传递分支名）
    - `GET /api/commits/:sha` → `{ ...CommitRow, meta }`（meta 来自 adapter，默认 `{}`）
    - `GET /api/commits/:sha/inclusion` → `{ commit, results: [{ branch, contains, status }] }`（未包含在前）
    - `GET /api/compare?base=&target=` → `{ ahead, behind, aheadCommits, behindCommits }`
    - `GET /api/events` → SSE（`commits.new`/`branches.updated`/`status.changed`）
  - 静态托管：`web/dist` 存在时注册 `@fastify/static`，SPA notFound 回退 index.html

- [ ] **Step 1: 实现 `server/src/platform/types.ts`（平台适配器接口）**

`server/src/platform/types.ts`：

```ts
export interface PlatformMeta { mrTitle?: string; mrUrl?: string }

export interface PlatformEvent { type: string; payload?: unknown }

export interface PlatformAdapter {
  enrichCommit?(sha: string): Promise<PlatformMeta | null>
  subscribe?(onEvent: (e: PlatformEvent) => void): () => void
}

export const nullAdapter: PlatformAdapter = {}
```

- [ ] **Step 2: 写失败测试 `server/test/sse.test.ts`**

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSseHub } from '../src/sse.js'
import type { FastifyReply } from 'fastify'

function fakeReply(): { reply: FastifyReply; writes: string[] } {
  const writes: string[] = []
  const res = new EventEmitter() as EventEmitter & { writeHead: unknown; write: unknown }
  ;(res as Record<string, unknown>).writeHead = () => {}
  ;(res as Record<string, unknown>).write = (s: string) => { writes.push(s) }
  const reply = { hijack: () => {}, raw: res } as unknown as FastifyReply
  return { reply, writes }
}

describe('SseHub', () => {
  it('publish 广播到所有客户端', () => {
    const hub = createSseHub()
    const a = fakeReply()
    const b = fakeReply()
    hub.add(a.reply)
    hub.add(b.reply)
    expect(hub.clientCount()).toBe(2)
    hub.publish('commits.new', { branch: 'master', count: 1 })
    expect(a.writes.some(w => w.includes('event: commits.new') && w.includes('"count":1'))).toBe(true)
    expect(b.writes.some(w => w.includes('event: commits.new'))).toBe(true)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm -C server test test/sse.test.ts`
Expected: FAIL —— `sse.js` 不存在。

- [ ] **Step 4: 实现 `server/src/sse.ts`**

```ts
import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'

export interface SseHub {
  add(reply: FastifyReply): void
  publish(event: string, data: unknown): void
  clientCount(): number
}

export function createSseHub(): SseHub {
  const clients = new Set<ServerResponse>()
  return {
    add(reply) {
      reply.hijack()
      const res = reply.raw
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write('retry: 3000\n\n')
      clients.add(res)
      res.on('close', () => { clients.delete(res) })
    },
    publish(event, data) {
      for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    clientCount() { return clients.size }
  }
}
```

- [ ] **Step 5: 写失败集成测试 `server/test/api.test.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOriginRepo } from './fixture.js'
import { buildApp } from '../src/app.js'
import type { AppHandle } from '../src/app.js'

describe('API 集成（真实 git fixture）', () => {
  let origin: ReturnType<typeof createOriginRepo>
  let handle: AppHandle
  let fixSha: string

  beforeAll(async () => {
    origin = createOriginRepo()
    origin.git(['checkout', '-b', 'release/1.0'])
    origin.git(['checkout', 'master'])
    fixSha = origin.commitFile('fix.txt', 'fix')

    handle = await buildApp({
      configOverride: {
        repos: [{ id: 'demo', url: origin.dir, defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
        server: { host: '127.0.0.1', port: 43900 }
      },
      dataDir: mkdtempSync(join(tmpdir(), 'gsm-data-'))
    })
    await handle.scheduler.runOnce()   // 首轮回填
  })

  afterAll(async () => { await handle.close() })

  it('GET /api/status 暴露调度状态与镜像路径', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.state).toBe('idle')
    expect(body.mirrorDir).toContain(join('repos', 'demo'))
    expect(body.lastFetch.status).toBe('ok')
  })

  it('GET /api/repos 返回配置仓库', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/repos' })
    expect(res.json()).toMatchObject([{ id: 'demo', defaultBranch: 'master', url: origin.dir }])
  })

  it('GET /api/branches 返回两个分支含提交信息', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/branches' })
    const rows = res.json()
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(['master', 'release/1.0'])
    const master = rows.find((r: { name: string }) => r.name === 'master')
    expect(master.headSha).toBeTruthy()
    expect(master.lastSubject).toBe('add fix.txt')
    expect(master.recentCommits).toBeGreaterThanOrEqual(0)
  })

  it('GET /api/commits?branch= 分页返回提交', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/commits?branch=master&limit=10' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)  // fixture README + fix.txt
  })

  it('GET /api/commits/:sha/inclusion 未包含在前且状态正确', async () => {
    // fixture：release/1.0 自 fixSha 提交之前的 master 分出 → 不包含 fixSha；master 包含
    origin.commitFile('next.txt', 'n')                     // master 新提交
    await handle.scheduler.runOnce()
    const res = await handle.app.inject({ method: 'GET', url: `/api/commits/${fixSha}/inclusion` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.commit.sha).toBe(fixSha)
    const byName = Object.fromEntries(
      body.results.map((r: { branch: string; contains: boolean }) => [r.branch, r.contains])
    )
    expect(byName['master']).toBe(true)
    expect(byName['release/1.0']).toBe(false)
    expect(body.results[0]).toMatchObject({ branch: 'release/1.0', contains: false })  // 未包含排序在前
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm -C server test test/api.test.ts`
Expected: FAIL —— buildApp 不认识 `configOverride`（app.ts 仍是 Task 1 最小版）。

- [ ] **Step 7: 实现 `server/src/api.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import type { AppConfig, RepoConfig } from './config.js'
import type { Scheduler } from './scheduler.js'
import type { SseHub } from './sse.js'
import type { PlatformAdapter } from './platform/types.js'
import { GitCommandError } from './gitRunner.js'
import { aheadBehind, compareBranches, inclusionForCommit, type BranchStatus } from './analyzer.js'
import { listCommits } from './sync.js'

interface BranchDbRow {
  name: string; status: string; head_sha: string | null; rewritten_at: number | null
}
interface CommitDbRow {
  sha: string; author_name: string | null; author_email: string | null
  committed_at: number; subject: string | null; body: string | null; first_seen_branch: string | null
}

export interface ApiDeps {
  config: AppConfig
  db: Database.Database
  mirrorDirFor(repoId: string): string
  scheduler: Scheduler
  sse: SseHub
  adapter: PlatformAdapter
}

function mapCommit(r: CommitDbRow): Record<string, unknown> {
  return {
    sha: r.sha, authorName: r.author_name, authorEmail: r.author_email,
    committedAt: r.committed_at, subject: r.subject, body: r.body, firstSeenBranch: r.first_seen_branch
  }
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, config } = deps
  const repo: RepoConfig = config.repos[0]   // v1 单仓库
  const mirrorDir = deps.mirrorDirFor(repo.id)

  app.get('/api/status', async () => {
    const lastFetch = db.prepare(`SELECT * FROM fetch_events WHERE repo_id=? ORDER BY id DESC LIMIT 1`).get(repo.id) ?? null
    return { ...deps.scheduler.status, mirrorDir, lastFetch }
  })

  app.get('/api/repos', async () =>
    config.repos.map(({ id, url, defaultBranch, pollIntervalSeconds }) => ({ id, url, defaultBranch, pollIntervalSeconds }))
  )

  app.get('/api/branches', async () => {
    const rows = db.prepare(`SELECT * FROM branches WHERE repo_id=? ORDER BY name`).all(repo.id) as BranchDbRow[]
    const now = Date.now()
    const out = []
    for (const r of rows) {
      const head = r.head_sha
        ? db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, r.head_sha) as CommitDbRow | undefined
        : undefined
      let behindDefault: number | null = null
      if (r.status === 'active') {
        try { behindDefault = (await aheadBehind(mirrorDir, repo.defaultBranch, r.name)).ahead }
        catch { behindDefault = null }
      }
      const recent = db.prepare(
        `SELECT COUNT(*) AS n FROM commits WHERE repo_id=? AND first_seen_branch=? AND first_seen_at>?`
      ).get(repo.id, r.name, now - 24 * 3600 * 1000) as { n: number }
      out.push({
        name: r.name, status: r.status, headSha: r.head_sha,
        lastSubject: head?.subject ?? null, lastAuthor: head?.author_name ?? null,
        lastCommitAt: head?.committed_at ?? null,
        behindDefault, rewritten: r.rewritten_at != null, recentCommits: recent.n
      })
    }
    return out
  })

  app.get('/api/commits', async (req, reply) => {
    const q = req.query as { branch?: string; limit?: string; offset?: string }
    if (!q.branch) return reply.code(400).send({ code: 'bad_request', message: '缺少 branch 参数' })
    try {
      const commits = await listCommits(mirrorDir, `refs/heads/${q.branch}`, {
        maxCount: Number(q.limit ?? 50), skip: Number(q.offset ?? 0)
      })
      return commits.map(mapCommit)
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })

  app.get('/api/commits/:sha', async (req, reply) => {
    const { sha } = req.params as { sha: string }
    const row = db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, sha) as CommitDbRow | undefined
    if (!row) return reply.code(404).send({ code: 'commit_not_found' })
    const meta = deps.adapter.enrichCommit ? await deps.adapter.enrichCommit(sha) : null
    return { ...mapCommit(row), meta: meta ?? {} }
  })

  app.get('/api/commits/:sha/inclusion', async (req, reply) => {
    const { sha } = req.params as { sha: string }
    const row = db.prepare(`SELECT * FROM commits WHERE repo_id=? AND sha=?`).get(repo.id, sha) as CommitDbRow | undefined
    if (!row) return reply.code(404).send({ code: 'commit_not_found' })
    const branchRows = db.prepare(`SELECT name, status, rewritten_at FROM branches WHERE repo_id=?`).all(repo.id) as BranchDbRow[]
    const branches = branchRows.map(b => ({
      name: b.name,
      status: (b.status === 'deleted' ? 'deleted' : b.rewritten_at != null ? 'rewritten' : 'active') as BranchStatus
    }))
    try {
      const results = await inclusionForCommit(mirrorDir, sha, branches)
      results.sort((a, b) => Number(a.contains) - Number(b.contains))  // 未包含在前
      return { commit: mapCommit(row), results }
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'commit_not_found' })
      throw e
    }
  })

  app.get('/api/compare', async (req, reply) => {
    const q = req.query as { base?: string; target?: string }
    if (!q.base || !q.target) return reply.code(400).send({ code: 'bad_request', message: '缺少 base/target 参数' })
    try {
      return await compareBranches(mirrorDir, q.base, q.target)
    } catch (e) {
      if (e instanceof GitCommandError) return reply.code(404).send({ code: 'branch_not_found' })
      throw e
    }
  })

  app.get('/api/events', (_req, reply) => {
    deps.sse.add(reply)
  })
}
```

- [ ] **Step 8: 重写 `server/src/app.ts` 为完整装配**

```ts
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { loadConfig, type AppConfig } from './config.js'
import { openDb } from './db.js'
import { Scheduler } from './scheduler.js'
import { createSseHub, type SseHub } from './sse.js'
import { registerApi } from './api.js'
import { nullAdapter, type PlatformAdapter } from './platform/types.js'

export interface AppOptions {
  configPath?: string
  dataDir?: string
  configOverride?: AppConfig
  adapter?: PlatformAdapter
}

export interface AppHandle {
  app: FastifyInstance
  config: AppConfig
  scheduler: Scheduler
  sse: SseHub
  close(): Promise<void>
}

export async function buildApp(options: AppOptions = {}): Promise<AppHandle> {
  const config = options.configOverride
    ?? loadConfig(options.configPath ?? join(homedir(), '.git-sync-monitor', 'config.json'))
  const dataDir = options.dataDir ?? join(homedir(), '.git-sync-monitor')
  const db: Database.Database = openDb(join(dataDir, 'monitor.db'))
  const mirrorDirFor = (repoId: string): string => join(dataDir, 'repos', repoId)
  const sse: SseHub = createSseHub()
  const repo = config.repos[0]

  const scheduler = new Scheduler({
    db, repo, mirrorDir: mirrorDirFor(repo.id),
    handlers: {
      onCommitsNew: (branch, commits) => sse.publish('commits.new', {
        branch, count: commits.length, subjects: commits.slice(0, 5).map(c => c.subject)
      }),
      onBranchesUpdated: () => sse.publish('branches.updated', {}),
      onStatus: s => sse.publish('status.changed', s)
    }
  })

  const app = Fastify({ logger: false })
  app.get('/api/ping', async () => ({ pong: true }))
  await registerApi(app, { config, db, mirrorDirFor, scheduler, sse, adapter: options.adapter ?? nullAdapter })

  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  if (existsSync(webDist)) {
    const fastifyStatic = (await import('@fastify/static')).default
    await app.register(fastifyStatic, { root: webDist })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ code: 'not_found' })
      return reply.sendFile('index.html')
    })
  }

  const close = async (): Promise<void> => {
    scheduler.stop()
    await app.close()
    db.close()
  }
  return { app, config, scheduler, sse, close }
}
```

重写 `server/src/index.ts`：

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from './app.js'

const configPath = process.env.GSM_CONFIG ?? join(homedir(), '.git-sync-monitor', 'config.json')
const dataDir = process.env.GSM_DATA ?? join(homedir(), '.git-sync-monitor')

const { app, config, scheduler, close } = await buildApp({ configPath, dataDir })
scheduler.start()
await app.listen({ host: config.server.host, port: config.server.port })
console.log(`git-sync-monitor 已启动: http://${config.server.host}:${config.server.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void close().then(() => process.exit(0)) })
}
```

更新 `server/test/smoke.test.ts`（buildApp 现在需要配置）：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'

const testConfig: AppConfig = {
  repos: [{ id: 't', url: '/tmp/does-not-matter', defaultBranch: 'master', branchExclude: [], pollIntervalSeconds: 30 }],
  server: { host: '127.0.0.1', port: 43900 }
}

describe('app 冒烟', () => {
  it('GET /api/ping 返回 pong', async () => {
    const { app, close } = await buildApp({ configOverride: testConfig, dataDir: mkdtempSync(join(tmpdir(), 'gsm-smoke-')) })
    const res = await app.inject({ method: 'GET', url: '/api/ping' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ pong: true })
    await close()
  })
})
```

- [ ] **Step 9: 运行全部服务端测试通过**

Run: `pnpm -C server test`
Expected: PASS（全部用例，含冒烟、sse、api 集成）。

- [ ] **Step 10: 提交**

```bash
git add server/src server/test && git commit -m "feat: SSE hub、REST API、平台适配器接口与 buildApp 完整装配"
```

---

### Task 11: 前端三视图与实时刷新

**Files:**
- Create: `web/src/api.ts`、`web/src/router.ts`、`web/src/views/Overview.vue`、`web/src/views/CommitDetail.vue`、`web/src/views/Compare.vue`
- Modify: `web/src/main.ts`（挂路由）、`web/src/App.vue`（导航壳）、`web/src/style.css`（完整样式）
- Test: `web/test/api.test.ts`（formatRelative + connectEvents 映射）、`web/test/CommitDetail.test.ts`（核心视图组件测试）

**Interfaces:**
- Consumes: Task 10 全部 REST/SSE 端点（含 §8 偏差：分支提交走 `/api/commits?branch=`）
- Produces: 页面路由 `/`（总览）、`/commit/:sha`（提交详情）、`/compare?base=&target=`（分支对比）；`api.ts` 导出类型 `CommitRow/BranchRow/InclusionRow/StatusDto/CompareDto` 与 `formatRelative(ts, now?)`、`connectEvents(handlers)`。

**说明**：自动测试覆盖 `api.ts` 纯逻辑与核心视图 CommitDetail（未包含置顶标红/复制按钮/状态分组）；Overview 与 Compare 通过 Task 12 的手动验收清单核对（vitest 组件测试收益低，不为此扩依赖）。

- [ ] **Step 1: 写失败测试 `web/test/api.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectEvents, formatRelative } from '../src/api.js'

describe('formatRelative', () => {
  const now = 1_700_000_000_000
  it('相对时间分级', () => {
    expect(formatRelative(now - 10_000, now)).toBe('刚刚')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatRelative(now - 3 * 3600_000, now)).toBe('3 小时前')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 天前')
  })
})

class FakeEventSource {
  static last: FakeEventSource | null = null
  listeners = new Map<string, (e: MessageEvent) => void>()
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { this.listeners.set(type, fn) }
  close(): void {}
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

describe('connectEvents', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('SSE 事件映射到回调', () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    const onCommitsNew = vi.fn()
    const onStatus = vi.fn()
    connectEvents({ onCommitsNew, onStatus })
    const es = FakeEventSource.last!
    expect(es.url).toBe('/api/events')
    es.emit('commits.new', { branch: 'master', count: 1 })
    es.emit('status.changed', { state: 'idle' })
    expect(onCommitsNew).toHaveBeenCalledWith({ branch: 'master', count: 1 })
    expect(onStatus).toHaveBeenCalledWith({ state: 'idle' })
  })
})
```

- [ ] **Step 2: 写失败测试 `web/test/CommitDetail.test.ts`**

```ts
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CommitDetail from '../src/views/CommitDetail.vue'

const sha = 'a'.repeat(40)
const payload = {
  commit: { sha, authorName: 'Alice', authorEmail: 'a@x', committedAt: 1, subject: 'fix: 严重崩溃', body: '', firstSeenBranch: 'master' },
  // 故意乱序传入，验证组件按「未包含→已包含→灰显」分区渲染
  results: [
    { branch: 'release/2.0', contains: true, status: 'active' },
    { branch: 'release/1.0', contains: false, status: 'active' },
    { branch: 'master', contains: true, status: 'active' },
    { branch: 'tmp/x', contains: false, status: 'deleted' }
  ]
}

async function mountView() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => payload })))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/commit/:sha', component: CommitDetail }]
  })
  await router.push(`/commit/${sha}`)
  await router.isReady()
  const wrapper = mount(CommitDetail, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('CommitDetail 视图', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('未包含红色置顶，已包含其后，删除分支灰显', async () => {
    const wrapper = await mountView()
    const html = wrapper.html()
    const missIdx = html.indexOf('release/1.0')
    const okIdx = html.indexOf('release/2.0')
    const otherIdx = html.indexOf('tmp/x')
    expect(missIdx).toBeGreaterThan(-1)
    expect(missIdx).toBeLessThan(okIdx)           // 未包含在已包含之前
    expect(wrapper.findAll('.row-miss').map(w => w.text())).toEqual(['release/1.0'])
    expect(wrapper.findAll('.row-ok').map(w => w.text())).toEqual(expect.arrayContaining(['master', 'release/2.0']))
    expect(wrapper.findAll('.row-other').map(w => w.text())).toEqual(['tmp/x'])
    expect(otherIdx).toBeGreaterThan(-1)
  })

  it('复制按钮写入 cherry-pick 命令', async () => {
    const wrapper = await mountView()
    const btn = wrapper.findAll('button').find(b => b.text().includes('git cherry-pick'))!
    await btn.trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`git cherry-pick ${sha}`)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm -C web test`
Expected: FAIL —— `../src/api.js`、`../src/views/CommitDetail.vue` 不存在。

- [ ] **Step 4: 实现 `web/src/api.ts`**

```ts
export interface CommitRow {
  sha: string
  authorName: string | null
  authorEmail: string | null
  committedAt: number
  subject: string | null
  body: string | null
  firstSeenBranch: string | null
}

export interface BranchRow {
  name: string
  status: 'active' | 'deleted'
  headSha: string | null
  lastSubject: string | null
  lastAuthor: string | null
  lastCommitAt: number | null
  behindDefault: number | null
  rewritten: boolean
  recentCommits: number
}

export type InclusionStatus = 'active' | 'deleted' | 'rewritten'
export interface InclusionRow { branch: string; contains: boolean; status: InclusionStatus }

export interface StatusDto {
  state: 'starting' | 'running' | 'idle' | 'backoff'
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveFailures: number
  lastError: string | null
  lastNewCommits: number | null
  mirrorDir: string
  lastFetch: { status: string; started_at: number; finished_at: number | null; error: string | null } | null
}

export interface CompareDto {
  ahead: number
  behind: number
  aheadCommits: CommitRow[]
  behindCommits: CommitRow[]
}

export interface RepoDto { id: string; url: string; defaultBranch: string; pollIntervalSeconds: number }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  status: (): Promise<StatusDto> => getJson('/api/status'),
  repos: (): Promise<RepoDto[]> => getJson('/api/repos'),
  branches: (): Promise<BranchRow[]> => getJson('/api/branches'),
  branchCommits: (branch: string, limit = 100): Promise<CommitRow[]> =>
    getJson(`/api/commits?branch=${encodeURIComponent(branch)}&limit=${limit}`),
  commitInclusion: (sha: string): Promise<{ commit: CommitRow; results: InclusionRow[] }> =>
    getJson(`/api/commits/${sha}/inclusion`),
  compare: (base: string, target: string): Promise<CompareDto> =>
    getJson(`/api/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`)
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export interface EventHandlers {
  onCommitsNew?: (data: { branch: string; count: number; subjects: string[] }) => void
  onBranchesUpdated?: () => void
  onStatus?: (data: StatusDto) => void
}

export function connectEvents(handlers: EventHandlers): EventSource {
  const es = new EventSource('/api/events')
  const bind = (type: string, fn?: (data: never) => void): void => {
    if (!fn) return
    es.addEventListener(type, e => fn(JSON.parse((e as MessageEvent).data)))
  }
  bind('commits.new', handlers.onCommitsNew as ((data: never) => void) | undefined)
  bind('branches.updated', handlers.onBranchesUpdated as ((data: never) => void) | undefined)
  bind('status.changed', handlers.onStatus as ((data: never) => void) | undefined)
  return es
}
```

- [ ] **Step 5: 实现 `web/src/router.ts` 并更新 `web/src/main.ts`、`web/src/App.vue`**

`web/src/router.ts`：

```ts
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import Overview from './views/Overview.vue'
import CommitDetail from './views/CommitDetail.vue'
import Compare from './views/Compare.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: Overview },
  { path: '/commit/:sha', name: 'commit', component: CommitDetail },
  { path: '/compare', name: 'compare', component: Compare }
]

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes })
}
```

`web/src/main.ts`：

```ts
import { createApp } from 'vue'
import { createAppRouter } from './router'
import App from './App.vue'
import './style.css'

createApp(App).use(createAppRouter()).mount('#app')
```

`web/src/App.vue`：

```vue
<template>
  <div class="app">
    <nav class="nav">
      <RouterLink to="/">总览</RouterLink>
      <RouterLink to="/compare">分支对比</RouterLink>
    </nav>
    <RouterView />
  </div>
</template>
```

- [ ] **Step 6: 实现 `web/src/views/CommitDetail.vue`（核心视图）**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api, formatRelative, type CommitRow, type InclusionRow } from '../api'

const route = useRoute()
const sha = route.params.sha as string
const commit = ref<CommitRow | null>(null)
const results = ref<InclusionRow[]>([])
const error = ref('')
const copied = ref(false)

const missing = computed(() => results.value.filter(r => !r.contains && r.status === 'active'))
const present = computed(() => results.value.filter(r => r.contains))
const other = computed(() => results.value.filter(r => !r.contains && r.status !== 'active'))

onMounted(async () => {
  try {
    const data = await api.commitInclusion(sha)
    commit.value = data.commit
    results.value = data.results
  } catch (e) {
    error.value = (e as Error).message
  }
})

async function copyCherryPick(): Promise<void> {
  await navigator.clipboard.writeText(`git cherry-pick ${sha}`)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <section class="commit-detail">
    <p v-if="error" class="banner banner-red">加载失败：{{ error }}</p>
    <template v-if="commit">
      <header class="commit-head">
        <h2>{{ commit.subject }}</h2>
        <p class="muted">
          <code>{{ sha.slice(0, 10) }}</code>
          · {{ commit.authorName }} · {{ formatRelative(commit.committedAt) }}
          · 来自分支 {{ commit.firstSeenBranch }}
        </p>
        <pre v-if="commit.body" class="commit-body">{{ commit.body }}</pre>
      </header>

      <h3 class="sec-miss">未包含以下提交的分支（{{ missing.length }}）</h3>
      <ul class="rows">
        <li v-for="r in missing" :key="r.branch" class="row row-miss">
          <span class="dot dot-red" /> {{ r.branch }}
          <button class="btn" @click="copyCherryPick">复制 git cherry-pick {{ sha.slice(0, 10) }}</button>
        </li>
        <li v-if="missing.length === 0" class="muted">（无 —— 所有活跃分支都已包含该提交）</li>
      </ul>
      <p v-if="copied" class="muted">已复制到剪贴板 ✓</p>

      <h3 class="sec-ok">已包含的分支（{{ present.length }}）</h3>
      <ul class="rows">
        <li v-for="r in present" :key="r.branch" class="row row-ok">
          <span class="dot dot-green" /> {{ r.branch }}
          <span v-if="r.status === 'rewritten'" class="badge badge-gray">历史重写</span>
        </li>
      </ul>

      <details v-if="other.length">
        <summary>已删除/异常分支（{{ other.length }}）</summary>
        <ul class="rows">
          <li v-for="r in other" :key="r.branch" class="row row-other">
            <span class="dot dot-gray" /> {{ r.branch }}
            <span class="badge badge-gray">{{ r.status === 'deleted' ? '已删除' : '历史重写' }}</span>
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>
```

- [ ] **Step 7: 实现 `web/src/views/Overview.vue`**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, connectEvents, formatRelative, type BranchRow, type StatusDto } from '../api'

const router = useRouter()
const status = ref<StatusDto | null>(null)
const defaultBranch = ref('master')
const branches = ref<BranchRow[]>([])
let es: EventSource | null = null

async function refresh(): Promise<void> {
  const [s, b, repos] = await Promise.all([api.status(), api.branches(), api.repos()])
  status.value = s
  branches.value = b
  defaultBranch.value = repos[0]?.defaultBranch ?? 'master'
}

onMounted(async () => {
  await refresh()
  es = connectEvents({
    onCommitsNew: () => void refresh(),
    onBranchesUpdated: () => void refresh(),
    onStatus: s => { if (status.value) status.value = s }
  })
})
onUnmounted(() => { es?.close() })

const active = (): BranchRow[] => branches.value.filter(b => b.status === 'active')
const deleted = (): BranchRow[] => branches.value.filter(b => b.status === 'deleted')

function bannerClass(): string {
  const s = status.value
  if (!s) return 'banner-gray'
  if (s.state === 'backoff' || s.consecutiveFailures > 0) return 'banner-yellow'
  if (s.lastFetch && s.lastFetch.status === 'failed') return 'banner-red'
  return 'banner-green'
}
function bannerText(): string {
  const s = status.value
  if (!s) return '连接中…'
  if (s.consecutiveFailures > 0) return `监听重试中（第 ${s.consecutiveFailures} 次失败），下次重试 ${s.nextRunAt ? formatRelative(s.nextRunAt) : '稍后'}`
  return `监听正常 · 上次同步 ${s.lastRunAt ? formatRelative(s.lastRunAt) : '从未'}`
}
function openCompare(b: BranchRow): void {
  void router.push({ path: '/compare', query: { base: defaultBranch.value, target: b.name } })
}
</script>

<template>
  <section class="overview">
    <div class="banner" :class="bannerClass()">{{ bannerText() }}</div>
    <p v-if="status?.lastError" class="muted err">最近错误：{{ status.lastError }}</p>

    <table class="tbl">
      <thead>
        <tr><th>分支</th><th>最新提交</th><th>作者</th><th>时间</th><th>落后默认分支</th><th>新提交</th></tr>
      </thead>
      <tbody>
        <tr v-for="b in active()" :key="b.name">
          <td>
            {{ b.name }}
            <span v-if="b.name === defaultBranch" class="badge badge-blue">默认</span>
            <span v-if="b.rewritten" class="badge badge-gray">历史重写</span>
          </td>
          <td>{{ b.lastSubject ?? '—' }}</td>
          <td>{{ b.lastAuthor ?? '—' }}</td>
          <td>{{ b.lastCommitAt ? formatRelative(b.lastCommitAt) : '—' }}</td>
          <td>
            <button v-if="(b.behindDefault ?? 0) > 0" class="badge badge-yellow" @click="openCompare(b)">
              落后 {{ b.behindDefault }} ↑
            </button>
            <span v-else class="muted">0</span>
          </td>
          <td>
            <span v-if="b.recentCommits > 0" class="badge badge-red">{{ b.recentCommits }}</span>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <details v-if="deleted().length">
      <summary>已删除分支（{{ deleted().length }}）</summary>
      <ul class="rows">
        <li v-for="b in deleted()" :key="b.name" class="row row-other">{{ b.name }}</li>
      </ul>
    </details>
  </section>
</template>
```

- [ ] **Step 8: 实现 `web/src/views/Compare.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, formatRelative, type BranchRow, type CompareDto } from '../api'

const route = useRoute()
const router = useRouter()
const names = ref<string[]>([])
const base = ref((route.query.base as string) ?? '')
const target = ref((route.query.target as string) ?? '')
const result = ref<CompareDto | null>(null)
const error = ref('')

async function loadBranches(): Promise<void> {
  const rows: BranchRow[] = await api.branches()
  names.value = rows.filter(r => r.status === 'active').map(r => r.name)
  if (!base.value) base.value = names.value[0] ?? ''
  if (!target.value) target.value = names.value[1] ?? base.value
  await load()
}

async function load(): Promise<void> {
  if (!base.value || !target.value || base.value === target.value) { result.value = null; return }
  try {
    result.value = await api.compare(base.value, target.value)
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
    result.value = null
  }
}

watch([base, target], () => {
  void router.replace({ path: '/compare', query: { base: base.value, target: target.value } })
  void load()
})

onMounted(() => { void loadBranches() })
</script>

<template>
  <section class="compare">
    <div class="pick">
      <label>基准 <select v-model="base"><option v-for="n in names" :key="n" :value="n">{{ n }}</option></select></label>
      <label>目标 <select v-model="target"><option v-for="n in names" :key="n" :value="n">{{ n }}</option></select></label>
    </div>
    <p v-if="error" class="banner banner-red">{{ error }}</p>
    <p v-if="result" class="muted">
      {{ base }} 领先 {{ target }} <strong>{{ result.ahead }}</strong> 个提交，
      落后 <strong>{{ result.behind }}</strong> 个提交
    </p>

    <div v-if="result" class="cols">
      <div>
        <h3>{{ base }} 独有（{{ result.aheadCommits.length }}）</h3>
        <ul class="rows">
          <li v-for="c in result.aheadCommits" :key="c.sha" class="row">
            <RouterLink :to="`/commit/${c.sha}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.aheadCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
      <div>
        <h3>{{ target }} 独有（{{ result.behindCommits.length }}）</h3>
        <ul class="rows">
          <li v-for="c in result.behindCommits" :key="c.sha" class="row">
            <RouterLink :to="`/commit/${c.sha}`"><code>{{ c.sha.slice(0, 10) }}</code> {{ c.subject }}</RouterLink>
            <span class="muted"> {{ c.authorName }} · {{ formatRelative(c.committedAt) }}</span>
          </li>
          <li v-if="result.behindCommits.length === 0" class="muted">（无）</li>
        </ul>
      </div>
    </div>
  </section>
</template>
```

- [ ] **Step 9: 写完整样式 `web/src/style.css`**

```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; margin: 0; color: #1f2328; background: #f6f8fa; }
.app { max-width: 1080px; margin: 0 auto; padding: 16px; }
.nav { display: flex; gap: 16px; margin-bottom: 16px; font-size: 15px; }
.nav a { text-decoration: none; color: #0969da; padding: 4px 8px; border-radius: 6px; }
.nav a.router-link-active { background: #ddf4ff; }
h2, h3 { margin: 12px 0 8px; }
.muted { color: #656d76; font-size: 13px; }
.muted.err { color: #cf222e; }
code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; }

.banner { padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; }
.banner-green { background: #dafbe1; color: #116329; }
.banner-yellow { background: #fff8c5; color: #7d4e00; }
.banner-red { background: #ffebe9; color: #cf222e; }
.banner-gray { background: #eaeef2; color: #57606a; }

.tbl { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; }
.tbl th, .tbl td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #d0d7de; font-size: 14px; }
.tbl th { background: #f6f8fa; }

.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; border: none; cursor: default; }
button.badge { cursor: pointer; }
.badge-red { background: #ffebe9; color: #cf222e; }
.badge-green { background: #dafbe1; color: #116329; }
.badge-yellow { background: #fff8c5; color: #7d4e00; }
.badge-gray { background: #eaeef2; color: #57606a; }
.badge-blue { background: #ddf4ff; color: #0969da; }

.rows { list-style: none; padding: 0; margin: 0; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; margin-bottom: 4px; background: #fff; font-size: 14px; }
.row-miss { background: #ffebe9; color: #cf222e; font-weight: 600; }
.row-ok { background: #dafbe1; color: #116329; }
.row-other { background: #eaeef2; color: #57606a; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot-red { background: #cf222e; }
.dot-green { background: #1a7f37; }
.dot-gray { background: #8c959f; }

.btn { border: 1px solid #d0d7de; background: #f6f8fa; border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; }
.btn:hover { background: #eaeef2; }

.commit-body { background: #fff; padding: 10px; border-radius: 6px; white-space: pre-wrap; font-size: 13px; }
.pick { display: flex; gap: 16px; margin-bottom: 12px; }
.pick select { padding: 4px 8px; border-radius: 6px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
a { color: #0969da; text-decoration: none; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  .tbl, .row, .commit-body, .rows .row { background: #161b22; border-color: #30363d; }
  .tbl th { background: #161b22; }
  .muted { color: #8b949e; }
  code { background: #21262d; }
  .nav a.router-link-active { background: #121d2f; }
}
```

- [ ] **Step 10: 运行前端测试通过**

Run: `pnpm -C web test`
Expected: PASS（api + CommitDetail 全部用例）。

- [ ] **Step 11: 前端可构建**

Run: `pnpm -C web build`
Expected: exit 0，产出 `web/dist`。

- [ ] **Step 12: 运行后端全部测试确认无回归，并提交**

Run: `pnpm test`
Expected: server + web 全部 PASS。

```bash
git add -A && git commit -m "feat: 前端三视图（总览/提交详情/分支对比）与 SSE 实时刷新"
```

---

### Task 12: 构建整合、fixture 脚本、README 与验收回归

**Files:**
- Create: `scripts/make-fixture.sh`、`README.md`
- Verify（不改动）: 根 `package.json` 脚本、`server/src/app.ts` 静态托管

**Interfaces:**
- Consumes: 前后端全部产物（T1-T11）
- Produces: 一键演示 fixture 脚本；README（安装/配置/运行/验收清单）；§14 五条验收全部通过

- [ ] **Step 1: 写 `scripts/make-fixture.sh`**

```bash
#!/usr/bin/env bash
# 用法: scripts/make-fixture.sh /tmp/gsm-demo-origin
# 创建一个带 master 与 release/1.0 的演示仓库，供监控站本地验收使用。
set -euo pipefail
DIR="${1:?用法: make-fixture.sh <目标目录>}"
rm -rf "$DIR"
git init --initial-branch=master "$DIR"
git -C "$DIR" config user.name "Demo"
git -C "$DIR" config user.email "demo@example.com"
echo "# demo" > "$DIR/README.md"
git -C "$DIR" add README.md && git -C "$DIR" commit -m "init: 项目骨架"
git -C "$DIR" checkout -b release/1.0
echo "rel" > "$DIR/rel.txt" && git -C "$DIR" add rel.txt && git -C "$DIR" commit -m "feat: release 专用配置"
git -C "$DIR" checkout master
echo "fix" > "$DIR/fix.txt" && git -C "$DIR" add fix.txt && git -C "$DIR" commit -m "fix: 严重崩溃修复（仅 master，release 未包含）"
echo "演示仓库已创建: $DIR"
echo "master 与 release/1.0 已分叉；在监控页打开 fix 提交应看到 release/1.0 标红。"
```

Run: `chmod +x scripts/make-fixture.sh && bash -n scripts/make-fixture.sh`
Expected: 语法检查通过。

- [ ] **Step 2: 写 `README.md`**

````markdown
# Git 分支同步监控站

实时监控同一 Git 仓库多个分支之间的差异；对任意提交判定其他分支是否包含，未包含的标红置顶提醒。

## 快速开始

```bash
pnpm install

# 1. 生成演示仓库（或跳过，直接用真实仓库地址）
scripts/make-fixture.sh /tmp/gsm-demo-origin

# 2. 写配置
mkdir -p ~/.git-sync-monitor
cat > ~/.git-sync-monitor/config.json <<'EOF'
{
  "repos": [
    {
      "id": "demo",
      "url": "/tmp/gsm-demo-origin",
      "defaultBranch": "master",
      "branchExclude": [],
      "pollIntervalSeconds": 30
    }
  ],
  "server": { "host": "127.0.0.1", "port": 43900 }
}
EOF

# 3. 启动（开发模式，前端 5173 / 后端 43900）
pnpm dev
# 或生产模式（后端 43900 同时托管前端构建产物）
pnpm build && pnpm start
```

打开 http://127.0.0.1:5173（开发）或 http://127.0.0.1:43900（生产）。

## 配置说明

| 字段 | 说明 |
|------|------|
| `repos[].url` | 任意 git 可达地址（ssh/https/本地路径）；网站通过 `git clone --mirror` 只读监听 |
| `repos[].defaultBranch` | 总览页"落后默认分支"徽标的基准 |
| `repos[].branchExclude` | 不监控的分支 glob（支持 `*`、`**`），如 `["tmp/*"]` |
| `repos[].pollIntervalSeconds` | 轮询间隔，默认 30，最小 5 |
| `server.host/port` | 监听地址，默认 127.0.0.1:43900（仅本机访问） |

环境变量：`GSM_CONFIG` 覆盖配置路径，`GSM_DATA` 覆盖数据目录（默认 `~/.git-sync-monitor/`，内含镜像、SQLite 与审计事件）。

## 使用

- **总览**：分支列表 + 监听状态条；"落后默认分支"黄色徽标点击直达对比；24h 内新提交计数红色徽标。
- **提交详情**：点任意提交进入；未包含该提交的活跃分支红色置顶，一键复制 `git cherry-pick <sha>`。
- **分支对比**：任选两分支查看双向独有提交。

## 已知语义（重要）

包含判定基于提交 SHA 祖先关系：cherry-pick 产生的不同 SHA 会被判为"未包含"，这是 git 固有语义，工具如实标注不做猜测。

## 测试

```bash
pnpm test        # server + web 全部单元/集成测试（集成测试用真实 git fixture）
```

## 验收清单（对应设计文档 §14）

1. [ ] 对 fixture 仓库 master 新提交后 ≤ pollIntervalSeconds+1 秒，总览页免刷新出现红色计数徽标
2. [ ] 提交详情页：release/1.0 红色置顶显示于"未包含"区，master 在"已包含"区；复制按钮可用
3. [ ] 断网（改坏 url）后恢复，漏掉提交补齐且无重复（集成测试 `scheduler.test.ts` 覆盖，UI 层复验一次）
4. [ ] force-push 后分支出现"历史重写"徽标；删除分支进入折叠区
5. [ ] `pnpm test` 全绿；`pnpm build && pnpm start` 后按上述配置可对真实内部仓库运行
````

- [ ] **Step 3: 生产构建与启动冒烟**

```bash
pnpm build
ls web/dist/index.html server/dist/index.js
```

Expected: 构建退出码 0，`web/dist/index.html` 与 `server/dist/index.js` 两个产物都存在。

再手动验证托管（在仓库根执行，需先写好 `~/.git-sync-monitor/config.json` 指向 fixture）：

```bash
node server/dist/index.js & sleep 2
curl -sf http://127.0.0.1:43900/api/ping && curl -sf http://127.0.0.1:43900/ | head -5
kill %1
```

Expected: `/api/ping` 返回 `{"pong":true}`；`/` 返回 index.html（`<div id="app">`）。

- [ ] **Step 4: 全量回归**

Run: `pnpm test`
Expected: server + web 全部 PASS，零失败零跳过（跳过需说明理由）。

- [ ] **Step 5: 手动验收（对照 README 验收清单）**

```bash
scripts/make-fixture.sh /tmp/gsm-demo-origin
# 写好 config.json 指向该目录后：
pnpm dev
# 浏览器打开 http://127.0.0.1:5173，逐条核对 README 五条验收清单并在本任务提交信息中记录结果
```

在另一个终端模拟远端新提交：

```bash
cd /tmp/gsm-demo-origin && echo more >> fix.txt && git add fix.txt && git commit -m "fix: 后续修复" && git checkout release/1.0 && git merge master --no-edit && git checkout master
```

Expected: ≤31 秒内总览页 master 行出现红色计数徽标（免刷新）；打开该提交详情，release/1.0 合并前标红、合并后刷新变绿。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "docs: fixture 脚本、README 与验收回归"
```

---

## 需求覆盖映射（自审记录）

| 设计文档条目 | 任务 |
|------|------|
| FR1 监听（fetch --prune/ref diff） | T4、T5、T9 |
| FR2 包含判定 + 标红 + cherry-pick 命令 | T8、T10（inclusion 端点）、T11（CommitDetail） |
| FR3 分支总览 + 落后黄标 | T10（/api/branches）、T11（Overview） |
| FR4 分支对比 | T8（compareBranches）、T10、T11（Compare） |
| FR5 SSE 实时刷新 | T9（事件回调）、T10（SseHub）、T11（connectEvents） |
| FR6 多仓库预留 | T6（表结构 repo_id）、T2（repos 数组配置）、T10（mirrorDirFor(repoId)；UI v1 单仓库） |
| FR7 韧性（退避/补齐/不重复） | T3（超时）、T9（退避/自愈测试）、T7（INSERT OR IGNORE 幂等） |
| §3.3 cherry-pick 语义 | T8 专门用例锁定 |
| §5.4 首次回填不产生事件 | T9 用例"首次运行全量回填且不触发 onCommitsNew" |
| §7 平台适配器 | T10（platform/types.ts + nullAdapter + /api/commits/:sha 的 meta） |
| §11 镜像损坏自愈 | T9（CORRUPT_RE + 用例） |
| §14 验收 1-5 | T12（README 清单 + 手动验收步骤；第 3 条另有自动化覆盖） |
| NFR2（包含判定 <500ms） | 由"单条 --contains 批量判定"设计保证（T8），不做专项压测；如接入真实仓库后超阈值再优化（设计文档 §15-3） |
| §10 配置语义 | T2（zod 默认值/校验、glob 过滤） |
