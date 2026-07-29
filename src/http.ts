import type { Logger } from 'pino'

export interface AppEnv {
  Variables: {
    requestId: string
    requestLogger: Logger
  }
}
