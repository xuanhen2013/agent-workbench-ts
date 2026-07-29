import type { OpenAIResponseInputItem } from '@/clients/openai'

export enum ReActStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

export interface ReActState {
  goal: string
  history: OpenAIResponseInputItem[]
  pendingToolCalls: Array<{
    callId: string
    name: string
    arguments: string
  }>
  candidateAnswer?: string
  toolRounds: number
  maxToolRounds: number
  status: ReActStatus
  answer?: string
  error?: { code: string, message: string }
  failureCount: number
  maxFailures: number
}

export interface ReActInput {
  goal: string
  maxToolRounds?: number
  maxFailures?: number
}

export type ReActOutput = Pick<ReActState, 'status' | 'answer' | 'error'>
