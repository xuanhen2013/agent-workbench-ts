import type { ErrorMappingRule } from '@/errors/map-error'
import type { AgentFailure } from '@/runtime'
import { APIConnectionError } from 'openai'
import { mapError } from '@/errors/map-error'
import { FailureCode, FailureKind } from '@/runtime'

type OpenAIFailureCode
  = | FailureCode.RateLimited
    | FailureCode.ServiceUnavailable
    | FailureCode.InvalidInput
    | FailureCode.NetworkError
    | FailureCode.InternalError

/** OpenAI/兼容网关异常转换后的安全消息。 */
export const OpenAIErrorMessages: Record<OpenAIFailureCode, string> = {
  [FailureCode.RateLimited]: 'Model service rate limit reached.',
  [FailureCode.ServiceUnavailable]: 'Model service is temporarily unavailable.',
  [FailureCode.InvalidInput]: 'Model request is invalid.',
  [FailureCode.NetworkError]: 'Model service connection failed.',
  [FailureCode.InternalError]: 'Model request failed.',
}

const networkErrorCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
])

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined
  }

  return typeof error.status === 'number' ? error.status : undefined
}

function hasNetworkErrorCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }

  return typeof error.code === 'string' && networkErrorCodes.has(error.code)
}

function isExplicitNetworkError(error: unknown): boolean {
  if (error instanceof APIConnectionError || hasNetworkErrorCode(error)) {
    return true
  }

  return typeof error === 'object'
    && error !== null
    && 'cause' in error
    && hasNetworkErrorCode(error.cause)
}

function failure(
  kind: FailureKind,
  code: OpenAIFailureCode,
): AgentFailure {
  return {
    kind,
    code,
    message: OpenAIErrorMessages[code],
  }
}

const openAIErrorRules: readonly ErrorMappingRule<AgentFailure>[] = [
  {
    matches: error => getHttpStatus(error) === 429,
    map: () => failure(FailureKind.Transient, FailureCode.RateLimited),
  },
  {
    matches: (error) => {
      const status = getHttpStatus(error)
      return status !== undefined && status >= 500 && status <= 599
    },
    map: () => failure(FailureKind.Transient, FailureCode.ServiceUnavailable),
  },
  {
    matches: (error) => {
      const status = getHttpStatus(error)
      return status === 400 || status === 422
    },
    map: () => failure(FailureKind.InvalidInput, FailureCode.InvalidInput),
  },
  {
    matches: isExplicitNetworkError,
    map: () => failure(FailureKind.Transient, FailureCode.NetworkError),
  },
]

/** 将 SDK/兼容网关异常转换成 runtime 可重试的 AgentFailure。 */
export function classifyOpenAIError(error: unknown): AgentFailure {
  return mapError(
    error,
    openAIErrorRules,
    () => failure(FailureKind.Internal, FailureCode.InternalError),
  )
}
