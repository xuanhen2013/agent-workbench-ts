export enum FailureKind {
  Transient = 'transient',
  Timeout = 'timeout',
  InvalidInput = 'invalid_input',
  Aborted = 'aborted',
  UncertainSideEffect = 'uncertain_side_effect',
  Internal = 'internal',
}

export enum FailureCode {
  // 网络或上游服务问题
  ServiceUnavailable = 'service_unavailable',
  RateLimited = 'rate_limited',
  NetworkError = 'network_error',

  // Harness 自己产生
  AttemptTimeout = 'attempt_timeout',
  OperationAborted = 'operation_aborted',

  // 业务与安全边界
  InvalidInput = 'invalid_input',
  UncertainSideEffect = 'uncertain_side_effect',

  // 无法继续细分
  InternalError = 'internal_error',
}

export interface AgentFailure {
  kind: FailureKind
  code: FailureCode
  message: string
}

export interface CallPolicy {
  timeoutMs: number
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  shouldRetry: (failure: AgentFailure, attempt: number) => boolean
}

export class AgentCallError extends Error {
  constructor(readonly failure: AgentFailure) {
    super(failure.message)
    this.name = 'AgentCallError'
  }
}

export function createAbortedError(): AgentCallError {
  return new AgentCallError({
    kind: FailureKind.Aborted,
    code: FailureCode.OperationAborted,
    message: 'The operation was cancelled.',
  })
}

export function createTimeoutError(timeoutMs: number): AgentCallError {
  return new AgentCallError({
    kind: FailureKind.Timeout,
    code: FailureCode.AttemptTimeout,
    message: `The attempt timed out after ${timeoutMs} ms.`,
  })
}

export function createInternalError(message: string): AgentCallError {
  return new AgentCallError({
    kind: FailureKind.Internal,
    code: FailureCode.InternalError,
    message,
  })
}

export async function executeWithPolicy<T>(args: {
  policy: CallPolicy
  parentSignal: AbortSignal
  execute: (signal: AbortSignal, attempt: number) => Promise<T>
  classify: (error: unknown) => AgentFailure
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<T> {
  if (!Number.isInteger(args.policy.maxAttempts)
    || args.policy.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be at least 1')
  }

  let attempt = 0

  while (attempt < args.policy.maxAttempts) {
    attempt++

    async function runAttempt(): Promise<T> {
      if (args.parentSignal.aborted) {
        throw createAbortedError()
      }

      const attemptController = new AbortController()
      const timer = setTimeout(() => {
        attemptController.abort(createTimeoutError(args.policy.timeoutMs))
      }, args.policy.timeoutMs)
      let attemptEventFn: EventListener | null = null

      function parentSignalEventListener() {
        attemptController.abort(createAbortedError())
      }

      args.parentSignal.addEventListener('abort', parentSignalEventListener)

      try {
        const result = await Promise.race([
          new Promise<never>(
            (_, reject) => {
              attemptEventFn = () => reject(attemptController.signal.reason)
              attemptController.signal.addEventListener(
                'abort',
                attemptEventFn,
                { once: true },
              )
            },
          ),
          args.execute(attemptController.signal, attempt),
        ])

        return result
      }
      finally {
        attemptEventFn && attemptController.signal.removeEventListener('abort', attemptEventFn)
        timer && clearTimeout(timer)
        args.parentSignal.removeEventListener('abort', parentSignalEventListener)
      }
    }

    try {
      return await runAttempt()
    }
    catch (error) {
      const failure = error instanceof AgentCallError ? error.failure : args.classify(error)

      const retryableKind = [FailureKind.Transient, FailureKind.Timeout].includes(failure.kind)

      const canRetry
        = attempt < args.policy.maxAttempts
          && retryableKind
          && args.policy.shouldRetry(failure, attempt)

      if (!canRetry) {
        throw new AgentCallError(failure)
      }
    }

    const delayMs = Math.min(
      args.policy.initialDelayMs * 2 ** (attempt - 1),
      args.policy.maxDelayMs,
    )
    await args.sleep(delayMs, args.parentSignal)
  }

  throw createInternalError('The retry loop exited unexpectedly.')
}
