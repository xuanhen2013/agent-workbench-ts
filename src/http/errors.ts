/** HTTP 边界使用的稳定错误码；不承载 Graph 或 SDK 的内部错误类型。 */
export enum HttpErrorCode {
  NotFound = 'NOT_FOUND',
  InternalError = 'INTERNAL_ERROR',
  HttpError = 'HTTP_ERROR',
  InvalidJson = 'invalid_json',
  ThreadNotFound = 'thread_not_found',
  JokeGraphFailed = 'joke_graph_failed',
  JokeSnapshotInconsistent = 'joke_snapshot_inconsistent',
  InvalidRequestBody = 'invalid_request_body',
  ThreadNotWaiting = 'thread_not_waiting',
  InterviewQuizFailed = 'interview_quiz_failed',
  InterviewQuizSnapshotInconsistent = 'interview_quiz_snapshot_inconsistent',
  InvalidQuizConfig = 'invalid_quiz_config',
  InvalidQuizSubmission = 'invalid_quiz_submission',
  ThreadNotWaitingForAnswers = 'thread_not_waiting_for_answers',
  ReviewIdMismatch = 'review_id_mismatch',
  InvalidNextRoundDecision = 'invalid_next_round_decision',
  ThreadNotWaitingForNextRound = 'thread_not_waiting_for_next_round',
}

export const HttpErrorMessages = {
  [HttpErrorCode.NotFound]: 'The requested endpoint does not exist.',
  [HttpErrorCode.InternalError]: 'The server could not process the request.',
  [HttpErrorCode.HttpError]: 'The HTTP request could not be completed.',
  [HttpErrorCode.InvalidJson]: 'The request body must be valid JSON.',
  [HttpErrorCode.ThreadNotFound]: 'The requested thread was not found.',
  [HttpErrorCode.JokeGraphFailed]: 'The joke graph failed.',
  [HttpErrorCode.JokeSnapshotInconsistent]: 'The joke graph stopped without a review or terminal state.',
  [HttpErrorCode.InvalidRequestBody]: 'The request body is invalid.',
  [HttpErrorCode.ThreadNotWaiting]: 'The joke thread is not waiting for a review.',
  [HttpErrorCode.InterviewQuizFailed]: 'The interview quiz graph failed.',
  [HttpErrorCode.InterviewQuizSnapshotInconsistent]: 'The graph stopped without an interrupt or terminal state.',
  [HttpErrorCode.InvalidQuizConfig]: 'learnerId, initialDifficulty or maxRounds is invalid.',
  [HttpErrorCode.InvalidQuizSubmission]: 'The quiz submission is invalid.',
  [HttpErrorCode.ThreadNotWaitingForAnswers]: 'The quiz thread is not waiting for answers.',
  [HttpErrorCode.ReviewIdMismatch]: 'The reviewId does not match the pending review.',
  [HttpErrorCode.InvalidNextRoundDecision]: 'A valid result reviewId is required.',
  [HttpErrorCode.ThreadNotWaitingForNextRound]: 'The quiz thread is not waiting for the next round.',
} satisfies Record<HttpErrorCode, string>

export const HttpStatus = {
  BadRequest: 400,
  NotFound: 404,
  Conflict: 409,
  InternalServerError: 500,
} as const

export type HttpStatusCode = typeof HttpStatus[keyof typeof HttpStatus]

export interface HttpError {
  code: HttpErrorCode
  message: string
}

export function createHttpError(
  code: HttpErrorCode,
  message = HttpErrorMessages[code],
): HttpError {
  return { code, message }
}
