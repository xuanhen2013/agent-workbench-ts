import { describe, expect, test } from 'bun:test'
import { toSafeErrorLog } from '@/logger'

describe('safe structured logging', () => {
  test('AgentCallError 只保留分类字段，不保留敏感异常内容', () => {
    const error = Object.assign(
      new Error('secret prompt and provider response'),
      {
        failure: {
          kind: 'timeout',
          code: 'attempt_timeout',
          message: 'secret classified message',
        },
        cause: { token: 'secret-token' },
        response: 'secret response body',
      },
    )

    const fields = toSafeErrorLog(error)

    expect(fields).toEqual({
      errorName: 'Error',
      failureKind: 'timeout',
      failureCode: 'attempt_timeout',
    })
    expect(JSON.stringify(fields)).not.toContain('secret')
  })

  test('Adapter 稳定 code/status 可以记录，异常 name 会先限制格式', () => {
    const error = Object.assign(new Error('private SQL'), {
      name: 'unsafe name with private SQL',
      code: 'cloudflare_d1_checkpoint_request_timeout',
      status: 504,
    })

    expect(toSafeErrorLog(error)).toEqual({
      errorName: 'Error',
      errorCode: 'cloudflare_d1_checkpoint_request_timeout',
      httpStatus: 504,
    })
  })
})
