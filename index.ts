import process from 'node:process'
import { createApp } from './src/app'
import { createDefaultAppDeps } from './src/composition-root'
import { localLogFile, logger } from './src/logger'

const port = Number(process.env.PORT ?? 7233)
const appPromise = createDefaultAppDeps().then((deps) => {
  logger.info({
    component: 'server',
    event: 'server_started',
    port,
    ...(localLogFile ? { logFile: localLogFile } : {}),
  }, 'Agent workbench server started')
  return createApp(deps)
})

async function fetch(request: Request) {
  const app = await appPromise
  return app.fetch(request)
}

export default {
  idleTimeout: 100,
  port,
  fetch,
}
