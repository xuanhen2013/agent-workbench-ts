import process from 'node:process'
import { createApp } from './src/app'
import { createDefaultAppDeps } from './src/composition-root'

const port = Number(process.env.PORT ?? 7233)
const appPromise = createDefaultAppDeps().then(createApp)

async function fetch(request: Request) {
  const app = await appPromise
  return app.fetch(request)
}

export default {
  idleTimeout: 100,
  port,
  fetch,
}
