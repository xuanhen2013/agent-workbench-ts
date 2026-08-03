import type { QuizModelUsage } from '../../contracts'
import type { QuestionBank } from '../../question-bank/contracts'
import type {
  PlanningPlannerPort,
  QuizPlannerInput,
} from './planner'
import type { PlanningState } from './state'
import type { JdContext } from '@/agent/interview-quiz/jd/contracts'
import type { SearchKnowledgeOutput } from '@/agent/interview-quiz/tools/knowledge'
import type {
  ToolLoopModel,
  ToolLoopPolicy,
  ToolLoopToolResult,
} from '@/agent/tool-loop/contracts'
import type { ToolLoopState } from '@/agent/tool-loop/state'
import type { KnowledgeRetriever, RetrievedChunk } from '@/knowledge/contracts'
import type { LoadedSkill } from '@/skills/contracts'
import { END, START, StateGraph } from '@langchain/langgraph'
import { err, ok } from 'neverthrow'
import { JdToolName } from '@/agent/interview-quiz/tools/jd'
import { KnowledgeToolName } from '@/agent/interview-quiz/tools/knowledge'
import { createToolLoopGraph } from '@/agent/tool-loop/graph'
import { KnowledgeEvidenceRole } from '@/knowledge/contracts'
import { SkillToolName } from '@/tools/skill'
import {
  QuizRoundDraftSchema,
  QuizStrategy,
} from '../../contracts'
import {
  createInterviewQuizError,
  InterviewQuizErrorCode,
} from '../../errors'
import {
  AGENT_QUIZ_INSTRUCTIONS,
  MAX_ANSWER_EVIDENCE_SEARCHES,
  MAX_FORBIDDEN_QUESTION_STEMS,
  MAX_PLANNER_TOOL_ROUNDS,
  MAX_QUESTION_SIGNAL_SEARCHES,
  MAX_SIMILAR_JD_SEARCHES,
  mergeAvailableChunks,
  parseJson,
} from './planner'
import { PlanningStateSchema } from './state'

const MAX_PLANNER_FAILURES = 2

export interface CreatePlanningSubgraphOptions {
  planner: PlanningPlannerPort
  questionBank: Pick<QuestionBank, 'findRecentStems'>
  questionSignalRetriever: Pick<KnowledgeRetriever, 'search'>
}

interface PlannerLoopDomainState {
  plannerInput: QuizPlannerInput
  jdContext: JdContext | null
  retrievedChunks: RetrievedChunk[]
  loadedSkillNames: string[]
  questionSignalSearchCount: number
  answerEvidenceSearchCount: number
  similarJdSearchCount: number
}

function buildKnowledgeQuery(state: PlanningState) {
  const wrongKnowledgePoints
    = state.roundContext.strategy === QuizStrategy.Remediate
      ? state.previousWrongKnowledgePoints
      : []

  const focusKnowledgePoints = wrongKnowledgePoints.length > 0
    ? wrongKnowledgePoints
    : state.jdContext?.focusKnowledgePoints.length
      ? state.jdContext.focusKnowledgePoints
      : state.memoryContext.weakKnowledgePoints

  const focus = focusKnowledgePoints.length > 0
    ? focusKnowledgePoints.join(' ')
    : 'Agent 工程 Tool Calling LangGraph Context Memory'

  return [
    state.roundContext.difficulty,
    focus,
    '核心概念 常见误区',
  ].join(' ')
}

function uniqueBoundedStems(state: PlanningState): string[] {
  return [...new Set([
    ...state.completedQuestionStems,
    ...state.questionBankStems,
  ])].slice(0, MAX_FORBIDDEN_QUESTION_STEMS)
}

function buildPlannerInput(state: PlanningState): QuizPlannerInput {
  return {
    history: state.modelHistory,
    ...state.roundContext,
    previousQuestionStems: uniqueBoundedStems(state),
    retrievedChunks: state.retrievedChunks,
    memoryContext: state.memoryContext,
    jdContext: state.jdContext,
  }
}

function errorForToolFailure(result: ToolLoopToolResult) {
  const isKnowledgeTool = Object.values(KnowledgeToolName)
    .includes(result.name as KnowledgeToolName)
    || result.name === JdToolName.SearchSimilarJds

  return isKnowledgeTool
    ? createInterviewQuizError(InterviewQuizErrorCode.KnowledgeToolFailed)
    : createInterviewQuizError(InterviewQuizErrorCode.SkillToolFailed)
}

function toUsage(usage: ToolLoopState['usage']): QuizModelUsage | null {
  if (!usage)
    return null
  return {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  }
}

function mapLoopError(error: { code: string, message: string }) {
  if (error.code === 'model_call_failed') {
    return createInterviewQuizError(InterviewQuizErrorCode.PlannerCallFailed)
  }
  if (error.code === 'max_tool_rounds' || error.code === 'max_failures') {
    return createInterviewQuizError(InterviewQuizErrorCode.PlannerToolRoundLimit)
  }

  const known = Object.values(InterviewQuizErrorCode)
    .includes(error.code as InterviewQuizErrorCode)
  return known
    ? createInterviewQuizError(error.code as InterviewQuizErrorCode)
    : createInterviewQuizError(InterviewQuizErrorCode.PlannerCallFailed)
}

function createPlannerPolicy(
  options: CreatePlanningSubgraphOptions,
): ToolLoopPolicy<PlannerLoopDomainState, import('../../contracts').QuizRoundDraft> {
  return {
    instructions: AGENT_QUIZ_INSTRUCTIONS,

    createInitialHistory({ domainState }) {
      return options.planner.createInitialConversation({
        ...domainState.plannerInput,
        retrievedChunks: domainState.retrievedChunks,
      })
    },

    createToolSet({ domainState }) {
      return options.planner.createToolSet({
        jdContext: domainState.jdContext,
      })
    },

    beforeToolExecution({ domainState, calls }) {
      const questionSignalSearches = calls.filter(call => (
        call.name === KnowledgeToolName.SearchQuestionSignal
      )).length
      const answerEvidenceSearches = calls.filter(call => (
        call.name === KnowledgeToolName.SearchAnswerEvidence
      )).length
      const similarJdSearches = calls.filter(call => (
        call.name === JdToolName.SearchSimilarJds
      )).length

      if (
        domainState.questionSignalSearchCount + questionSignalSearches
        > MAX_QUESTION_SIGNAL_SEARCHES
      ) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.QuestionSignalSearchLimit,
        ))
      }
      if (
        domainState.answerEvidenceSearchCount + answerEvidenceSearches
        > MAX_ANSWER_EVIDENCE_SEARCHES
      ) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.AnswerEvidenceSearchLimit,
        ))
      }
      if (
        domainState.similarJdSearchCount + similarJdSearches
        > MAX_SIMILAR_JD_SEARCHES
      ) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.SimilarJdSearchLimit,
        ))
      }

      return ok({
        domainState: {
          ...domainState,
          questionSignalSearchCount:
            domainState.questionSignalSearchCount + questionSignalSearches,
          answerEvidenceSearchCount:
            domainState.answerEvidenceSearchCount + answerEvidenceSearches,
          similarJdSearchCount:
            domainState.similarJdSearchCount + similarJdSearches,
        },
      })
    },

    reduceToolResults({ domainState, results }) {
      const failedResult = results.find(result => !result.ok)
      if (failedResult)
        return err(errorForToolFailure(failedResult))

      const successfulResults = results.filter(
        (result): result is Extract<ToolLoopToolResult, { ok: true }> => (
          result.ok
        ),
      )
      let retrievedChunks = domainState.retrievedChunks
      const loadedSkillNames = new Set(domainState.loadedSkillNames)
      const outputItems = successfulResults.map((result) => {
        if (result.name === SkillToolName.LoadSkill) {
          loadedSkillNames.add((result.output as LoadedSkill).name)
        }

        let output: unknown = result.output
        if (
          result.name === KnowledgeToolName.SearchQuestionSignal
          || result.name === KnowledgeToolName.SearchAnswerEvidence
        ) {
          const knowledge = result.output as SearchKnowledgeOutput
          const before = new Set(retrievedChunks.map(chunk => chunk.chunkId))
          const merged = mergeAvailableChunks(retrievedChunks, knowledge.chunks)
          retrievedChunks = merged
          output = {
            chunks: merged.filter(chunk => !before.has(chunk.chunkId)),
          } satisfies SearchKnowledgeOutput
        }

        return {
          type: 'function_call_output' as const,
          call_id: result.callId,
          output: JSON.stringify(output),
        }
      })

      return ok({
        domainState: {
          ...domainState,
          retrievedChunks,
          loadedSkillNames: [...loadedSkillNames],
        },
        outputItems,
      })
    },

    finalize({ domainState, finalText }) {
      const requiredSkills = options.planner.getRequiredSkillNames()
      if (requiredSkills.some(skill => !domainState.loadedSkillNames.includes(skill))) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.RequiredSkillMissing,
        ))
      }
      if (!domainState.retrievedChunks.some(chunk => (
        chunk.evidenceRole === KnowledgeEvidenceRole.AnswerEvidence
      ))) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.AnswerEvidenceMissing,
        ))
      }
      if (!finalText) {
        return err(createInterviewQuizError(
          InterviewQuizErrorCode.SkillFinalOutputMissing,
        ))
      }

      const plannerInput: QuizPlannerInput = {
        ...domainState.plannerInput,
        retrievedChunks: domainState.retrievedChunks,
      }
      const result = parseJson(finalText)
        .andThen((candidate) => {
          const parsed = QuizRoundDraftSchema.safeParse(candidate)
          return parsed.success
            ? ok(parsed.data)
            : err(createInterviewQuizError(
                InterviewQuizErrorCode.InvalidQuizRoundDraft,
              ))
        })
        .andThen(draft => options.planner.validateDraft(draft, plannerInput))

      return result.map(draft => ({
        domainState,
        value: draft,
      }))
    },
  }
}

export function createPlanningSubgraph(
  options: CreatePlanningSubgraphOptions,
) {
  const toolLoop = createToolLoopGraph({
    model: {
      runTurn: input => options.planner.runModel({
        history: input.history,
        tools: input.tools,
        signal: input.signal,
      }),
    } satisfies ToolLoopModel,
    policy: createPlannerPolicy(options),
    initialToolChoice: 'auto',
  })

  return new StateGraph(PlanningStateSchema)
    .addNode('load_question_history', async (state, { signal }) => {
      const focusKnowledgePoints
        = state.roundContext.strategy === QuizStrategy.Remediate
          ? state.previousWrongKnowledgePoints
          : state.memoryContext.weakKnowledgePoints

      try {
        return {
          questionBankStems: await options.questionBank.findRecentStems({
            difficulty: state.roundContext.difficulty,
            knowledgePoints: focusKnowledgePoints,
            limit: 30,
            signal,
          }),
        }
      }
      catch {
        return {
          error: createInterviewQuizError(
            InterviewQuizErrorCode.QuestionBankReadFailed,
          ),
        }
      }
    })
    .addNode('retrieve_question_signals', async (state, { signal }) => {
      try {
        return {
          retrievedChunks: await options.questionSignalRetriever.search({
            query: buildKnowledgeQuery(state),
            limit: 4,
            filter: {
              evidenceRoles: [KnowledgeEvidenceRole.QuestionSignal],
              ownerId: null,
            },
            signal,
          }),
        }
      }
      catch {
        return {
          error: createInterviewQuizError(
            InterviewQuizErrorCode.KnowledgeRetrievalFailed,
          ),
        }
      }
    })
    .addNode('plan_round', async (state, runtime) => {
      try {
        const runId = `${state.threadId}:round:${state.roundContext.round}:planner`
        const loopState = await toolLoop.invoke({
          domainState: {
            plannerInput: buildPlannerInput(state),
            jdContext: state.jdContext,
            retrievedChunks: state.retrievedChunks,
            loadedSkillNames: [],
            questionSignalSearchCount: 0,
            answerEvidenceSearchCount: 0,
            similarJdSearchCount: 0,
          } satisfies PlannerLoopDomainState,
          maxToolRounds: MAX_PLANNER_TOOL_ROUNDS,
          maxFailures: MAX_PLANNER_FAILURES,
        }, {
          context: { runId },
          signal: runtime.signal,
          recursionLimit: 100,
        }) as ToolLoopState

        if (loopState.error) {
          return { error: mapLoopError(loopState.error) }
        }

        const output = loopState.output as import('../../contracts').QuizRoundDraft | null
        const domainState = loopState.domainState as PlannerLoopDomainState
        if (!output) {
          return {
            error: createInterviewQuizError(
              InterviewQuizErrorCode.SkillFinalOutputMissing,
            ),
          }
        }

        const plannerInput = {
          ...domainState.plannerInput,
          retrievedChunks: domainState.retrievedChunks,
        }
        return {
          candidateDraft: output,
          currentPlan: options.planner.materializeRoundPlan({
            threadId: state.threadId,
            plannerInput,
            draft: output,
          }),
          continuationItems: loopState.lastContinuationItems,
          modelUsage: toUsage(loopState.usage),
          retrievedChunks: domainState.retrievedChunks,
        }
      }
      catch {
        return {
          error: createInterviewQuizError(
            InterviewQuizErrorCode.PlannerCallFailed,
          ),
        }
      }
    })
    .addEdge(START, 'load_question_history')
    .addConditionalEdges('load_question_history', state => (
      state.error ? END : 'retrieve_question_signals'
    ))
    .addConditionalEdges('retrieve_question_signals', state => (
      state.error ? END : 'plan_round'
    ))
    .addEdge('plan_round', END)
    .compile()
}

export type PlanningSubgraph = ReturnType<typeof createPlanningSubgraph>
