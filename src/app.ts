import type { AppEnv } from '@/http'
import type { JokeGraph } from '@/routes/jokes'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from '@/logger'
import { registerJokeRoutes } from '@/routes/jokes'

export interface AppDeps {
  jokeGraph: JokeGraph
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.trim() || crypto.randomUUID()
    const startedAt = performance.now()
    const requestLogger = logger.child({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    })

    c.set('requestId', requestId)
    c.set('requestLogger', requestLogger)
    c.header('x-request-id', requestId)

    requestLogger.info('HTTP request started')
    await next()
    requestLogger.info({
      durationMs: Math.round(performance.now() - startedAt),
      status: c.res.status,
    }, 'HTTP request finished')
  })

  app.get('/health', (c) => {
    return c.json({
      requestId: c.get('requestId'),
      status: 'ok',
    })
  })

  registerJokeRoutes(app, deps.jokeGraph)

  app.notFound((c) => {
    return c.json({
      requestId: c.get('requestId'),
      status: 'failed',
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist.',
      },
    }, 404)
  })

  app.onError((error, c) => {
    const status = error instanceof HTTPException ? error.status : 500
    const message = error instanceof HTTPException
      ? error.message
      : 'The server could not process the request.'

    c.get('requestLogger').error({
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      status,
    }, 'HTTP request failed')

    return c.json({
      requestId: c.get('requestId'),
      status: 'failed',
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR',
        message,
      },
    }, status)
  })

  return app
}
