import type { Result } from 'neverthrow'
import type OpenAI from 'openai'
import type {
  QuizDifficulty,
  QuizModelUsage,
  QuizRoundDraft,
  QuizRoundPlan,
  QuizStrategy,
} from './contracts'
import type { OpenAIResponseInputItem } from '@/clients/openai'
import { err, ok } from 'neverthrow'
import { zodTextFormat } from 'openai/helpers/zod'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { OpenAIResponsesExecutor } from '@/clients/openai'
import { QuestionType, QuizRoundDraftSchema } from './contracts'

/**
 * Prompt Cache 要求稳定内容位于相同前缀，因此这里不能插入轮次、难度或错题。
 * 动态信息由 initialize/replan 作为最后一条 User 消息追加到 modelHistory。
 */
export const AGENT_QUIZ_INSTRUCTIONS = `
你是 Agent 工程面试选择题教练。

请严格遵守：
1. 每轮生成五道题，只能是单选或多选；
2. 题目只能考察 Agent 工程，包括 ReAct、Plan/RePlan、Tool Calling、LangGraph、Context、Memory、Skill、RAG、Harness 或 Multi-Agent；
3. 单选题必须且只能有一个正确答案；
4. 多选题至少有两个正确答案，且不能全部选项都正确；
5. 题干不能重复；
6. 输出必须符合指定 Structured Output Schema。
`.trim()

export const AGENT_QUIZ_PROMPT_CACHE_KEY = 'agent-interview-quiz:v1'

export interface QuizPlannerInput {
  history: OpenAIResponseInputItem[]
  round: number
  difficulty: QuizDifficulty
  strategy: QuizStrategy
  /** 业务历史用于确定性拒绝重复题目，不依赖模型自觉。 */
  previousQuestionStems: string[]
}

export interface QuizPlanError {
  code: string
  message: string
}

export type QuizPlanResult
  = | {
    ok: true
    draft: QuizRoundDraft
    continuationItems: OpenAIResponseInputItem[]
    usage?: QuizModelUsage
  }
  | {
    ok: false
    error: QuizPlanError
  }

function parseJson(text: string): Result<unknown, QuizPlanError> {
  try {
    return ok(JSON.parse(text))
  }
  catch {
    return err({
      code: 'planner_json_invalid',
      message: '模型没有返回合法 JSON',
    })
  }
}

function normalizeStem(stem: string) {
  return stem.trim().toLowerCase().replace(/\s+/g, ' ')
}

export class QuizPlanner {
  private readonly model: string
  private readonly executor: OpenAIResponsesExecutor

  constructor(client: OpenAI, model: string) {
    this.model = model
    this.executor = new OpenAIResponsesExecutor({ client })
  }

  _validateQuizRoundDraft(
    draft: QuizRoundDraft,
    input: QuizPlannerInput,
  ): Result<QuizRoundDraft, QuizPlanError> {
    const previousStems = new Set(input.previousQuestionStems.map(normalizeStem))
    const currentStems = new Set<string>()

    for (const question of draft.questions) {
      const optionIds = question.options.map(option => option.optionId)
      const optionIdSet = new Set(optionIds)
      const correctIdSet = new Set(question.correctOptionIds)
      const normalizedStem = normalizeStem(question.stem)

      if (optionIdSet.size !== optionIds.length) {
        return err({
          code: 'duplicate_option_id',
          message: '同一道题中存在重复选项 ID',
        })
      }

      if (correctIdSet.size !== question.correctOptionIds.length) {
        return err({
          code: 'duplicate_correct_option_id',
          message: '同一道题中存在重复的正确答案 ID',
        })
      }

      if (!question.correctOptionIds.every(id => optionIdSet.has(id))) {
        return err({
          code: 'correct_option_not_found',
          message: '正确答案引用了不存在的选项',
        })
      }

      if (
        question.type === QuestionType.Single
        && question.correctOptionIds.length !== 1
      ) {
        return err({
          code: 'invalid_single_answer_count',
          message: '单选题必须且只能有一个正确答案',
        })
      }

      if (
        question.type === QuestionType.Multiple
        && question.correctOptionIds.length < 2
      ) {
        return err({
          code: 'invalid_multiple_answer_count',
          message: '多选题必须至少有两个正确答案',
        })
      }

      if (
        question.type === QuestionType.Multiple
        && correctIdSet.size === optionIdSet.size
      ) {
        return err({
          code: 'invalid_multiple_all_options_correct',
          message: '多选题不能把全部选项都设为正确答案',
        })
      }

      if (previousStems.has(normalizedStem)) {
        return err({
          code: 'repeated_question_stem',
          message: '题目与历史轮次重复',
        })
      }

      if (currentStems.has(normalizedStem)) {
        return err({
          code: 'duplicate_question_stem',
          message: '本轮存在重复题干',
        })
      }

      currentStems.add(normalizedStem)
    }

    return ok(draft)
  }

  materializeRoundPlan(input: {
    threadId: string
    plannerInput: QuizPlannerInput
    draft: QuizRoundDraft
  }): QuizRoundPlan {
    const { threadId, plannerInput, draft } = input
    const prefix = `${threadId}:round:${plannerInput.round}`

    return {
      reviewId: `${prefix}:review`,
      round: plannerInput.round,
      difficulty: plannerInput.difficulty,
      strategy: plannerInput.strategy,
      questions: draft.questions.map((question, index) => ({
        ...question,
        questionId: `${prefix}:question:${index + 1}`,
      })),
    }
  }

  async createRound(
    input: QuizPlannerInput,
    options: { signal: AbortSignal },
  ): Promise<QuizPlanResult> {
    const response = await this.executor.runNoStream({
      model: this.model,
      instructions: AGENT_QUIZ_INSTRUCTIONS,
      input: input.history,
      text: {
        format: zodTextFormat(QuizRoundDraftSchema, 'agent_quiz_round'),
      },
      /** 相同 Prompt 版本共享 key；不要拼 threadId。 */
      prompt_cache_key: AGENT_QUIZ_PROMPT_CACHE_KEY,
    }, options)

    const result = parseJson(response.output_text)
      .andThen((candidate) => {
        const parsed = QuizRoundDraftSchema.safeParse(candidate)
        return parsed.success
          ? ok(parsed.data)
          : err({
              code: 'invalid_quiz_round_draft',
              message: '模型返回的数据不符合题目结构',
            })
      })
      .andThen(draft => this._validateQuizRoundDraft(draft, input))

    if (result.isErr()) {
      return {
        ok: false,
        error: result.error,
      }
    }

    const usage = response.usage

    return {
      ok: true,
      draft: result.value,
      continuationItems: toResponseInputItems(response.output),
      ...(usage
        ? {
            usage: {
              inputTokens: usage.input_tokens,
              cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
              cacheWriteTokens:
                usage.input_tokens_details?.cache_write_tokens ?? 0,
            },
          }
        : {}),
    }
  }
}
