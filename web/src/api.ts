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

export type QuizDifficulty = 'foundation' | 'intermediate' | 'advanced'
export type QuizStrategy = 'initial' | 'advance' | 'remediate'
export type QuizQuestionType = 'single' | 'multiple'
export type QuizCategoryId
  = 'orchestration' | 'tooling' | 'knowledge' | 'reliability'

export type SelectedJdReference
  = | { source: 'user_upload', documentId: string }
    | { source: 'market', itemKey: string }

export interface QuizConfig {
  initialDifficulty: QuizDifficulty
  maxRounds: number
  selectedJd?: SelectedJdReference
}

export interface QuizOption {
  optionId: string
  text: string
}

export interface QuizCategory {
  categoryId: QuizCategoryId
  name: string
  knowledgePoints: string[]
}

export interface QuizQuestion {
  questionId: string
  type: QuizQuestionType
  topic: string
  knowledgePoint: string
  stem: string
  options: QuizOption[]
}

export interface QuizSection {
  category: QuizCategory
  questions: QuizQuestion[]
}

export interface QuizRoundRequest {
  kind: 'interview_quiz_round'
  reviewId: string
  round: number
  difficulty: QuizDifficulty
  questionCount: number
  sections: QuizSection[]
}

export interface PublicQuizRoundResult {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  total: number
  correctCount: number
  allCorrect: boolean
  wrongKnowledgePoints: string[]
  sectionResults: Array<{
    category: QuizCategory
    total: number
    correctCount: number
    allCorrect: boolean
    questionResults: Array<{
      questionId: string
      type: QuizQuestionType
      topic: string
      knowledgePoint: string
      stem: string
      selectedOptions: QuizOption[]
      isCorrect: boolean
    }>
  }>
  questionResults: Array<{
    questionId: string
    type: QuizQuestionType
    topic: string
    knowledgePoint: string
    stem: string
    selectedOptions: QuizOption[]
    isCorrect: boolean
  }>
  modelUsage?: {
    inputTokens: number
    cachedTokens: number
    cacheWriteTokens: number
  }
}

export interface QuizRoundResultRequest {
  kind: 'interview_quiz_round_result'
  reviewId: string
  result: PublicQuizRoundResult
}

export interface InterviewQuizView {
  threadId: string
  status: 'needs_answers' | 'round_result' | 'completed' | 'failed'
  config: QuizConfig
  waitingQuestions?: QuizRoundRequest
  waitingResult?: QuizRoundResultRequest
  results: PublicQuizRoundResult[]
  error?: { code: string, message: string }
}

export interface ImportedJdView {
  jdDocumentId: string
  title: string
  chunkCount: number
}

export interface MarketJdCard {
  itemKey: string
  title: string
  company: string
  location: string
  salary: string
  highlights: string[]
}

export interface QuizProgressEvent {
  phase: string
  label: string
  categoryIndex?: number
  categoryCount?: number
}

/**
 * 浏览器只解析三种服务端事件：进度、最终安全视图和稳定错误。
 * 原始 Graph State 永远不进入这个 DTO。
 */
async function streamRequest(
  url: string,
  init: RequestInit,
  onProgress: (event: QuizProgressEvent) => void,
): Promise<InterviewQuizView> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json() as {
      error?: { message?: string }
    }
    throw new Error(body.error?.message ?? `HTTP ${response.status}`)
  }
  if (!response.body)
    throw new Error('The server did not return an SSE stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: InterviewQuizView | undefined

  const consume = (block: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:'))
        event = line.slice(6).trim()
      else if (line.startsWith('data:'))
        data.push(line.slice(5).trimStart())
    }
    if (data.length === 0)
      return

    const payload = JSON.parse(data.join('\n')) as unknown
    if (event === 'progress') {
      onProgress(payload as QuizProgressEvent)
    }
    else if (event === 'done') {
      result = payload as InterviewQuizView
    }
    else if (event === 'error') {
      const error = payload as { message?: string }
      throw new Error(error.message ?? 'The interview quiz stream failed.')
    }
  }

  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
      stream: !chunk.done,
    })
    let separator = buffer.indexOf('\n\n')
    while (separator >= 0) {
      consume(buffer.slice(0, separator))
      buffer = buffer.slice(separator + 2)
      separator = buffer.indexOf('\n\n')
    }
    if (chunk.done)
      break
  }
  if (buffer.trim())
    consume(buffer)

  if (!result)
    throw new Error('The interview quiz stream ended without a result.')
  return result
}

export function searchMarketJds(query: string) {
  const search = new URLSearchParams({ query })
  return request<{ items: MarketJdCard[] }>(
    `/api/interview-quiz/market-jds?${search}`,
  )
}

export function importInterviewJd(input: {
  learnerId: string
  title: string
  content: string
}) {
  return request<ImportedJdView>('/api/interview-quiz/jds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function createInterviewQuiz(
  input: QuizConfig & { learnerId: string },
) {
  return request<InterviewQuizView>('/api/interview-quiz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function createInterviewQuizStream(
  input: QuizConfig & { learnerId: string },
  onProgress: (event: QuizProgressEvent) => void,
) {
  return streamRequest('/api/interview-quiz/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, onProgress)
}

export function getInterviewQuiz(threadId: string) {
  return request<InterviewQuizView>(
    `/api/interview-quiz/${encodeURIComponent(threadId)}`,
  )
}

export function submitInterviewQuizAnswers(
  threadId: string,
  reviewId: string,
  answers: Array<{ questionId: string, selectedOptionIds: string[] }>,
) {
  return request<InterviewQuizView>(
    `/api/interview-quiz/${encodeURIComponent(threadId)}/answers`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId, answers }),
    },
  )
}

export function continueInterviewQuiz(
  threadId: string,
  reviewId: string,
) {
  return request<InterviewQuizView>(
    `/api/interview-quiz/${encodeURIComponent(threadId)}/next`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId, action: 'next_round' }),
    },
  )
}

export function continueInterviewQuizStream(
  threadId: string,
  reviewId: string,
  onProgress: (event: QuizProgressEvent) => void,
) {
  return streamRequest(
    `/api/interview-quiz/${encodeURIComponent(threadId)}/next/stream`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId, action: 'next_round' }),
    },
    onProgress,
  )
}
