import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { ReActModel } from '@/agent/react/model-adapter'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import {
  END,
  interrupt,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from '@langchain/langgraph'
import { z } from 'zod/v4'
import { InterruptReason, InterruptState } from './state'

/** 暂停时交给 Web 的问题；options 决定页面动态渲染哪些按钮。 */
export const DecisionRequestSchema = z.object({
  kind: z.literal('joke_review'),
  reviewId: z.string().min(1),
  round: z.number().int().positive(),
  joke: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.object({
    value: z.enum(InterruptReason),
    label: z.string().min(1),
  })).min(1),
}).strict()

/** Web 恢复 Graph 时提交的回答。 */
export const DecisionSchema = z.object({
  reviewId: z.string().min(1),
  result: z.enum(InterruptReason),
}).strict()

export const JokeStateSchema = new StateSchema({
  threadId: z.string().min(1),
  history: new ReducedValue(
    z.array(z.custom<OpenAIResponseInputItem>()).default(() => []),
    {
      reducer(
        left: OpenAIResponseInputItem[],
        right: OpenAIResponseInputItem[],
      ) {
        return left.concat(right.map((rawItem) => {
          // Responses output item 转成下一轮 input 时不保留流式 index。
          const { index: _index, ...item } = rawItem as OpenAIResponseInputItem & {
            index?: number
          }
          return item
        }))
      },
    },
  ),
  joke: z.string().default(''),
  status: z.enum(InterruptState).default(InterruptState.Running),
  round: z.number().int().nonnegative().default(0),
  maxRounds: z.number().int().positive().default(3),
  decision: DecisionSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
})

export interface CreateInterruptGraphOptions {
  checkpointer: BaseCheckpointSaver
  model: ReActModel
}

/**
 * 讲一个笑话并等待用户评价；拒绝后重新生成，最多三轮。
 * 模型由外部注入，Graph 只负责状态、Interrupt 和分支。
 */
export function createInterruptGraph(options: CreateInterruptGraphOptions) {
  return new StateGraph(JokeStateSchema)
    .addNode('initialize', () => ({
      history: [{ role: 'user', content: '讲一个简短的笑话给我' }],
      round: 0,
      status: InterruptState.Running,
    }))
    .addNode('next_round', () => ({
      history: [{ role: 'user', content: '一点都不好笑，请重新讲一个给我' }],
    }))
    .addNode('call_model', async (state, { signal }) => {
      const response = await options.model.runTurn({
        instructions: '',
        history: state.history,
        tools: [],
        signal,
      })
      const joke = response.finalText?.trim()

      if (!joke) {
        return {
          status: InterruptState.Failed,
          error: {
            code: 'empty_joke',
            message: 'The model did not return a joke.',
          },
        }
      }

      return {
        history: response.continuationItems,
        joke,
        round: state.round + 1,
      }
    })
    .addNode('wait_for_review', (state) => {
      // Node Resume 时会从头执行，因此 reviewId 必须由 Checkpoint State 确定性生成。
      const reviewId = `${state.threadId}:review:${state.round}`
      const request = DecisionRequestSchema.parse({
        kind: 'joke_review',
        reviewId,
        round: state.round,
        joke: state.joke,
        question: '好笑吗？',
        options: [
          { value: InterruptReason.Accepted, label: '是个好笑话' },
          { value: InterruptReason.Rejected, label: '一点都不好笑' },
        ],
      })

      const rawDecision = interrupt<typeof request, unknown>(request)
      const decision = DecisionSchema.safeParse(rawDecision)

      if (!decision.success) {
        return {
          status: InterruptState.Failed,
          error: {
            code: 'invalid_decision',
            message: 'The joke review decision is invalid.',
          },
        }
      }

      if (decision.data.reviewId !== request.reviewId) {
        return {
          status: InterruptState.Failed,
          error: {
            code: 'invalid_review_id',
            message: 'The decision does not match the pending joke review.',
          },
        }
      }

      return { decision: decision.data }
    })
    .addNode('success', () => ({
      status: InterruptState.Completed,
    }))
    .addNode('max_rounds_failed', () => ({
      status: InterruptState.Failed,
      error: {
        code: 'max_rounds_exceeded',
        message: 'The joke was rejected three times.',
      },
    }))
    .addNode('finish_failed', () => ({}))
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'call_model')
    .addEdge('next_round', 'call_model')
    .addConditionalEdges('call_model', state => (
      state.status === InterruptState.Failed ? 'finish_failed' : 'wait_for_review'
    ))
    .addConditionalEdges('wait_for_review', (state) => {
      if (state.status === InterruptState.Failed)
        return 'finish_failed'

      if (state.decision?.result === InterruptReason.Accepted)
        return 'success'

      return state.round >= state.maxRounds
        ? 'max_rounds_failed'
        : 'next_round'
    })
    .addEdge('success', END)
    .addEdge('max_rounds_failed', END)
    .addEdge('finish_failed', END)
    .compile({ checkpointer: options.checkpointer })
}
