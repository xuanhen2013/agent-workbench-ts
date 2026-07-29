import process from 'node:process'
import { createApp } from './src/app'
import { createDefaultAppDeps } from './src/composition-root'

const port = Number(process.env.PORT ?? 7233)
const app = createApp(createDefaultAppDeps())

export default {
  idleTimeout: 100,
  port,
  fetch: app.fetch,
}
