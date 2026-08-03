import type {
  ToolLoopCall,
  ToolLoopError,
  ToolLoopToolResult,
  ToolLoopUsage,
} from './contracts'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import { StateSchema } from '@langchain/langgraph'
import { z } from 'zod/v4'

export const ToolLoopStateSchema = new StateSchema({
  runId: z.string().default(''),
  conversation: z.array(
    z.custom<OpenAIResponseInputItem>(),
  ).default(() => []),
  pendingToolCalls: z.array(
    z.custom<ToolLoopCall>(),
  ).default(() => []),
  pendingToolResults: z.array(
    z.custom<ToolLoopToolResult>(),
  ).default(() => []),
  lastContinuationItems: z.array(
    z.custom<OpenAIResponseInputItem>(),
  ).default(() => []),
  finalText: z.string().nullable().default(null),
  toolRound: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  maxToolRounds: z.number().int().positive(),
  maxFailures: z.number().int().positive(),
  usage: z.custom<ToolLoopUsage>().nullable().default(null),
  domainState: z.custom<unknown>(),
  output: z.custom<unknown>().nullable().default(null),
  error: z.custom<ToolLoopError>().nullable().default(null),
})

export type ToolLoopState = typeof ToolLoopStateSchema.State
