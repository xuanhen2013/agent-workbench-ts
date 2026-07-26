import type { AppEnv } from '@/http'
import process from 'node:process'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from '@/logger'
import { agentRoutes } from '@/routes'

const isProduction = process.env.NODE_ENV === 'production'

export const app = new Hono<AppEnv>()

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

  requestLogger.info('HTTP 请求开始')
  await next()
  requestLogger.info({
    durationMs: Math.round(performance.now() - startedAt),
    status: c.res.status,
  }, 'HTTP 请求完成')
})

app.get('/health', (c) => {
  return c.json({
    requestId: c.get('requestId'),
    status: 'ok',
  })
})

app.route('/api', agentRoutes)

app.notFound((c) => {
  return c.json({
    requestId: c.get('requestId'),
    status: 'failed',
    error: {
      code: 'NOT_FOUND',
      message: '接口不存在',
    },
  }, 404)
})

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500
  const message = error instanceof HTTPException
    ? error.message
    : isProduction
      ? '服务内部错误'
      : error instanceof Error
        ? error.message
        : '未知错误'

  c.get('requestLogger').error({
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    status,
  }, 'HTTP 请求失败')

  return c.json({
    requestId: c.get('requestId'),
    status: 'failed',
    error: {
      code: status === 500 ? 'AGENT_FAILED' : 'HTTP_ERROR',
      message,
    },
  }, status)
})
