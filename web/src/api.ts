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

export interface QuizQuestion {
  questionId: string
  type: QuizQuestionType
  topic: string
  knowledgePoint: string
  stem: string
  options: QuizOption[]
}

export interface QuizRoundRequest {
  kind: 'interview_quiz_round'
  reviewId: string
  round: number
  difficulty: QuizDifficulty
  questionCount: 5
  questions: QuizQuestion[]
}

export interface PublicQuizRoundResult {
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  total: 5
  correctCount: number
  allCorrect: boolean
  wrongKnowledgePoints: string[]
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
