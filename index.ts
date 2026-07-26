import process from 'node:process'
import { app } from './src/app'

const port = Number(process.env.PORT ?? 7233)

export default {
  idleTimeout: 100,
  port,
  fetch: app.fetch,
}
