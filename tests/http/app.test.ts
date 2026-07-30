import { describe, expect, test } from 'bun:test'
import { createApp } from '@/app'
import { createJokeGraphFixture } from '../helpers/joke'
import { createQuizGraphFixture } from '../helpers/quiz'

function testApp() {
  return createApp({
    interviewQuizGraph: createQuizGraphFixture().graph,
    jokeGraph: createJokeGraphFixture().graph,
  })
}

describe('HTTP application shell', () => {
  test('exposes a health endpoint with a request ID', async () => {
    const response = await testApp().request('/health')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe(body.requestId)
    expect(body).toEqual({
      requestId: expect.any(String),
      status: 'ok',
    })
  })

  test('preserves a valid incoming request ID', async () => {
    const response = await testApp().request('/health', {
      headers: {
        'x-request-id': 'joke-http-test-1',
      },
    })
    const body = await response.json()

    expect(response.headers.get('x-request-id')).toBe('joke-http-test-1')
    expect(body.requestId).toBe('joke-http-test-1')
  })

  test('returns the shared error envelope for unknown paths', async () => {
    const response = await testApp().request('/api/missing')
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({
      requestId: expect.any(String),
      status: 'failed',
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist.',
      },
    })
  })
})
