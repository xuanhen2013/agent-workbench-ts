export type JokeDecision = 'accepted' | 'rejected'

export interface JokeReviewRequest {
  kind: 'joke_review'
  reviewId: string
  round: number
  joke: string
  question: string
  options: Array<{
    value: JokeDecision
    label: string
  }>
}

export interface JokeView {
  threadId: string
  status: 'needs_input' | 'completed' | 'failed'
  round: number
  joke?: string
  waiting?: JokeReviewRequest
  result?: { outcome: 'accepted', rounds: number }
  error?: { code: string, message: string }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json() as T & {
    error?: { code: string, message: string }
  }

  if (!response.ok)
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)

  return body
}

export function createJoke() {
  return request<JokeView>('/api/jokes', { method: 'POST' })
}

export function getJoke(threadId: string) {
  return request<JokeView>(`/api/jokes/${encodeURIComponent(threadId)}`)
}

export function resumeJoke(
  threadId: string,
  reviewId: string,
  result: JokeDecision,
) {
  return request<JokeView>(
    `/api/jokes/${encodeURIComponent(threadId)}/resume`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId, result }),
    },
  )
}
