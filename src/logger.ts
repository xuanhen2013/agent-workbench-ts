import process from 'node:process'
import pino from 'pino'
import pretty from 'pino-pretty'

const isProduction = process.env.NODE_ENV === 'production'
const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug')
const destination = isProduction
  ? undefined
  : pretty({
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
    })

export const logger = pino(
  {
    base: undefined,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
)
