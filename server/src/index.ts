import { buildApp } from './app.js'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 43900)

const { app, close } = await buildApp()
await app.listen({ host, port })
console.log(`git-sync-monitor listening on http://${host}:${port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void close().then(() => process.exit(0)) })
}
