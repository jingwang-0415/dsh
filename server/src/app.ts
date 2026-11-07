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
