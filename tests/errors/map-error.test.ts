import { describe, expect, test } from 'bun:test'
import { mapError } from '@/errors/map-error'

describe('explicit error mapper', () => {
  test('按声明顺序选择第一条匹配规则', () => {
    const result = mapError(
      { kind: 'rate_limit' },
      [
        {
          matches: value => (value as { kind?: string }).kind === 'rate_limit',
          map: () => 'transient',
        },
        {
          matches: () => true,
          map: () => 'fallback-rule',
        },
      ],
      () => 'fallback',
    )

    expect(result).toBe('transient')
  })

  test('没有规则匹配时使用调用方提供的 fallback', () => {
    const result = mapError(
      new Error('private detail'),
      [],
      () => ({ code: 'internal', message: 'safe message' }),
    )

    expect(result).toEqual({ code: 'internal', message: 'safe message' })
  })
})
