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
  // close 失败不能静默吞掉（进程以 0 退出会骗过进程管理器）：记录并以非零退出
  process.on(sig, () => {
    close().then(() => process.exit(0)).catch(err => {
      console.error('优雅退出失败', err)
      process.exit(1)
    })
  })
}
