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
