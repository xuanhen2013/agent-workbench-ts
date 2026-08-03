import type { ImportJdDocument, MarketJdCatalog } from './jd/contracts'
import type { OpenAIResponsesExecutor } from '@/clients/openai'
import type { SourceDocument } from '@/knowledge/contracts'
import { MemorySaver } from '@langchain/langgraph'
import { Database } from 'bun:sqlite'
import { createCloudflareAiSearchRetrieverFromEnv } from '@/knowledge/cloudflare-ai-search'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'
import {
  chunkDocuments,
  FakeEmbeddingModel,
  InMemoryKnowledgeRetriever,
  InMemoryKnowledgeStore,
} from '@/knowledge/in-memory-rag'
import {
  createCloudflareD1CheckpointSaverFromEnv,
} from '@/runtime/checkpoint/cloudflare-d1-checkpoint-saver'
import { loadSkillCatalog } from '@/skills/skill-loader'
import { loadInterviewBankDocuments } from './corpus/interview-bank-loader'
import { createInterviewQuizGraph } from './interview-quiz-graph'
import { importJdDocument } from './jd/import-jd'
import { RetrievedMarketJdCatalog } from './jd/market-jd-catalog'
import { SqliteLearningMemory } from './learning-memory/sqlite-learning-memory'
import { createCloudflareD1QuestionBankFromEnv } from './question-bank/cloudflare-d1-question-bank'
import { InMemoryQuestionBank } from './question-bank/in-memory-question-bank'
import { createPlanningSubgraph } from './subgraphs/planning/graph'
import { QuizPlanner } from './subgraphs/planning/planner'

/**
 * InterviewQuiz 对 HTTP 层暴露的完整功能，而不是内部基础设施清单。
 * QuestionBank、Memory、Checkpointer 和 Subgraph 都由已编译的 Graph 闭包持有。
 */
export interface InterviewQuizFeature {
  graph: ReturnType<typeof createInterviewQuizGraph>
  importJdDocument: ImportJdDocument
  marketJdCatalog?: MarketJdCatalog
}

export interface CreateInterviewQuizFeatureOptions {
  env: NodeJS.ProcessEnv
  /** OpenAI Executor 是进程级共享客户端，由最外层 Composition Root 创建。 */
  openAIExecutor: OpenAIResponsesExecutor
}

/**
 * InterviewQuiz 自己的功能级 Composition Root。
 *
 * 这里允许知道题库、长期记忆、RAG、Planner、Subgraph 和 Checkpointer
 * 的具体实现；Route 只拿最终 Feature，不参与这些基础设施的选择和初始化。
 */
export async function createInterviewQuizFeature(
  options: CreateInterviewQuizFeatureOptions,
): Promise<InterviewQuizFeature> {
  const { env, openAIExecutor } = options
  const skillCatalog = await loadSkillCatalog([
    new URL('../../../skills/question-authoring/', import.meta.url),
    new URL('../../../skills/knowledge-retrieval/', import.meta.url),
  ])

  /**
   * 没有配置真实题库时，使用一份很短的已核验基础摘录，
   * 让本地 Demo 仍然可以启动和出题。它不是完整知识库。
   */
  const knowledgeDocuments: SourceDocument[] = [{
    documentId: 'fixture:verified-agent-basics',
    sourceType: KnowledgeSourceType.UserNote,
    evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    ownerId: null,
    title: '已核验 Agent 工程基础摘录',
    sourceUri: 'fixture:verified-agent-basics',
    content: `
## StateGraph
StateGraph 的 Node 读取当前 State，并返回需要合并的局部状态更新。Edge 决定下一个 Node。

## Tool Calling
Tool Schema 描述工具名称、用途和输入参数结构。服务端仍然需要校验参数并执行真正的工具。

## Harness
Agent Harness 通常需要超时、重试、取消和调用预算，避免模型循环无限执行。

## Context
追加式 History 可以把上一轮的计划、执行结果和用户反馈提供给下一轮 RePlan。

## Checkpoint
Checkpointer 按 thread 保存 Graph 的当前状态和暂停点，使 Interrupt 后可以使用 resume 继续。
`.trim(),
  }]

  const interviewBankDirectory = env.INTERVIEW_BANK_DIR?.trim()
  if (interviewBankDirectory) {
    knowledgeDocuments.push(
      ...await loadInterviewBankDocuments(interviewBankDirectory),
    )
  }

  const chunks = chunkDocuments(knowledgeDocuments)
  const embeddingModel = new FakeEmbeddingModel()
  const startupSignal = new AbortController().signal
  const vectors = await embeddingModel.embedDocuments(
    chunks.map(chunk => chunk.text),
    { signal: startupSignal },
  )
  const knowledgeStore = new InMemoryKnowledgeStore()
  await knowledgeStore.upsert(
    chunks.map((chunk, index) => ({
      chunk,
      vector: vectors[index] ?? [],
    })),
    { signal: startupSignal },
  )
  const knowledgeRetriever = new InMemoryKnowledgeRetriever(
    embeddingModel,
    knowledgeStore,
  )

  const cloudflareAnswerEvidenceRetriever
    = createCloudflareAiSearchRetrieverFromEnv(env, {
      sourceTypes: [KnowledgeSourceType.Official],
      evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    })
  const cloudflareQuestionSignalRetriever
    = createCloudflareAiSearchRetrieverFromEnv(env, {
      sourceTypes: [
        KnowledgeSourceType.Jd,
        KnowledgeSourceType.InterviewBank,
      ],
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    })
  const cloudflareMarketJdRetriever
    = createCloudflareAiSearchRetrieverFromEnv(env, {
      sourceTypes: [KnowledgeSourceType.Jd],
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    })
  const marketJdCatalog = cloudflareMarketJdRetriever
    ? new RetrievedMarketJdCatalog(cloudflareMarketJdRetriever)
    : undefined
  const questionSignalRetriever
    = cloudflareQuestionSignalRetriever ?? knowledgeRetriever
  const answerEvidenceRetriever
    = cloudflareAnswerEvidenceRetriever ?? knowledgeRetriever

  const cloudflareQuestionBank
    = createCloudflareD1QuestionBankFromEnv(env)
  const questionBank = cloudflareQuestionBank ?? new InMemoryQuestionBank()
  if (cloudflareQuestionBank) {
    await cloudflareQuestionBank.initialize({
      signal: startupSignal,
    })
  }

  const cloudflareCheckpointSaver
    = createCloudflareD1CheckpointSaverFromEnv(env)
  if (cloudflareCheckpointSaver)
    await cloudflareCheckpointSaver.initialize()

  const learningMemoryDatabase = new Database(
    env.LEARNING_MEMORY_SQLITE_PATH?.trim()
    || 'agent-workbench.sqlite',
  )
  const learningMemory = new SqliteLearningMemory(learningMemoryDatabase)

  const planner = new QuizPlanner(openAIExecutor, {
    skillCatalog,
    questionSignalRetriever,
    answerEvidenceRetriever,
    marketJdCatalog,
  })
  const planningSubgraph = createPlanningSubgraph({
    planner,
    questionBank,
    questionSignalRetriever,
  })
  const graph = createInterviewQuizGraph({
    checkpointer: cloudflareCheckpointSaver ?? new MemorySaver(),
    planningSubgraph,
    jdRetriever: knowledgeRetriever,
    marketJdCatalog,
    questionBank,
    learningMemory,
  })

  return {
    graph,
    importJdDocument: (input, importOptions) => importJdDocument(input, {
      embedder: embeddingModel,
      store: knowledgeStore,
    }, importOptions),
    marketJdCatalog,
  }
}
