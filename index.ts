import { Hono } from 'hono'
import { IndexRouters } from './src/routes'

const app = new Hono()

app.route('/', IndexRouters)

export default {
  idleTimeout: 100,
  port: 7233,
  fetch: app.fetch,
}
