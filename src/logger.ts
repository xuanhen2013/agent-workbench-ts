import process from 'node:process'
import pino from 'pino'
import pretty from 'pino-pretty'

const isProduction = process.env.NODE_ENV === 'production'
const level = process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug')
const configuredLogFile = process.env.LOG_FILE?.trim()
export const localLogFile = configuredLogFile === 'off'
  ? undefined
  : configuredLogFile || (isProduction
    ? undefined
    : `logs/agent-workbench-${process.pid}.jsonl`)

const consoleDestination = isProduction
  ? pino.destination(1)
  : pretty({
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
    })
const streams: pino.StreamEntry[] = [{ stream: consoleDestination }]
if (localLogFile) {
  streams.push({
    stream: pino.destination({
      dest: localLogFile,
      mkdir: true,
      sync: false,
    }),
  })
}

export interface SafeErrorLogFields {
  errorName: string
  errorCode?: string
  failureKind?: string
  failureCode?: string
  httpStatus?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string'
    && /^[\w.-]{1,80}$/.test(value)
    ? value
    : undefined
}

/**
 * 只提取已经分类的错误标识；故意不读取 message、stack、cause 或响应正文。
 * 即使上游异常包含 Prompt、Token、SQL，也不会进入日志字段。
 */
export function toSafeErrorLog(error: unknown): SafeErrorLogFields {
  const value = isRecord(error) ? error : undefined
  const failure = value && isRecord(value.failure) ? value.failure : undefined
  const errorCode = safeIdentifier(value?.code)
  const failureKind = safeIdentifier(failure?.kind)
  const failureCode = safeIdentifier(failure?.code)
  const status = value?.status

  return {
    errorName: safeIdentifier(value?.name)
      ?? (error instanceof Error ? 'Error' : typeof error),
    ...(errorCode ? { errorCode } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(typeof status === 'number' && Number.isInteger(status)
      ? { httpStatus: status }
      : {}),
  }
}

export const logger = pino(
  {
    base: undefined,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization',
        'apiKey',
        'apiToken',
        'token',
        'prompt',
        'instructions',
        'history',
        'input',
        'output',
        'response',
        'sql',
        'params',
        '*.authorization',
        '*.apiKey',
        '*.apiToken',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  },
  pino.multistream(streams),
)
