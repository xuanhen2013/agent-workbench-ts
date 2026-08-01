import type { AppDeps } from '@/app'
import type { SourceDocument } from '@/knowledge/contracts'
import process from 'node:process'
import { MemorySaver } from '@langchain/langgraph'
import { Database } from 'bun:sqlite'
import { createInterruptGraph } from '@/agent/interrupt/interrupt-graph'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { QuizPlanner } from '@/agent/interview-quiz/planning'
import { OpenAIResponsesModel } from '@/agent/react/model-adapter'
import { createOpenAIResponsesExecutor } from '@/clients/openai'
import { importJdDocument } from '@/jd/import-jd'
import { RetrievedMarketJdCatalog } from '@/jd/market-jd-catalog'
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
import { loadInterviewBankDocuments } from '@/knowledge/interview-bank-loader'
import { SqliteLearningMemory } from '@/learning-memory/sqlite-learning-memory'
import { createCloudflareD1QuestionBankFromEnv } from '@/question-bank/cloudflare-d1-question-bank'
import { InMemoryQuestionBank } from '@/question-bank/in-memory-question-bank'
import { loadSkillCatalog } from '@/skills/skill-loader'

/** 正式进程只创建一次 Graph 和 MemorySaver，所有 Joke Route 共享同一状态仓库。 */
export async function createDefaultAppDeps(): Promise<AppDeps> {
  const skillCatalog = await loadSkillCatalog([
    new URL('../skills/question-authoring/', import.meta.url),
    new URL('../skills/knowledge-retrieval/', import.meta.url),
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

  const interviewBankDirectory = process.env.INTERVIEW_BANK_DIR?.trim()
  if (interviewBankDirectory) {
    knowledgeDocuments.push(
      ...await loadInterviewBankDocuments(interviewBankDirectory),
    )
  }

  const chunks = chunkDocuments(knowledgeDocuments)
  const embeddingModel = new FakeEmbeddingModel()
  const vectors = await embeddingModel.embedDocuments(
    chunks.map(chunk => chunk.text),
    { signal: new AbortController().signal },
  )
  const knowledgeStore = new InMemoryKnowledgeStore()
  await knowledgeStore.upsert(
    chunks.map((chunk, index) => ({
      chunk,
      vector: vectors[index] ?? [],
    })),
    { signal: new AbortController().signal },
  )
  const knowledgeRetriever = new InMemoryKnowledgeRetriever(
    embeddingModel,
    knowledgeStore,
  )
  const cloudflareAnswerEvidenceRetriever
    = createCloudflareAiSearchRetrieverFromEnv(process.env, {
      sourceTypes: [KnowledgeSourceType.Official],
      evidenceRole: KnowledgeEvidenceRole.AnswerEvidence,
    })
  const cloudflareQuestionSignalRetriever
    = createCloudflareAiSearchRetrieverFromEnv(process.env, {
      sourceTypes: [
        KnowledgeSourceType.Jd,
        KnowledgeSourceType.InterviewBank,
      ],
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
    })
  const cloudflareMarketJdRetriever
    = createCloudflareAiSearchRetrieverFromEnv(process.env, {
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
    = createCloudflareD1QuestionBankFromEnv(process.env)
  const questionBank = cloudflareQuestionBank ?? new InMemoryQuestionBank()
  if (cloudflareQuestionBank) {
    await cloudflareQuestionBank.initialize({
      signal: new AbortController().signal,
    })
  }
  const learningMemoryDatabase = new Database(
    process.env.LEARNING_MEMORY_SQLITE_PATH?.trim()
    || 'agent-workbench.sqlite',
  )
  const learningMemory = new SqliteLearningMemory(learningMemoryDatabase)

  const openAIExecutor = createOpenAIResponsesExecutor()
  const jokeGraph = createInterruptGraph({
    checkpointer: new MemorySaver(),
    model: new OpenAIResponsesModel(openAIExecutor),
  })
  const interviewQuizGraph = createInterviewQuizGraph({
    checkpointer: new MemorySaver(),
    planner: new QuizPlanner(openAIExecutor, {
      skillCatalog,
      questionSignalRetriever,
      answerEvidenceRetriever,
      marketJdCatalog,
    }),
    questionSignalRetriever,
    jdRetriever: knowledgeRetriever,
    marketJdCatalog,
    questionBank,
    learningMemory,
  })

  return {
    interviewQuizGraph,
    jokeGraph,
    importJdDocument: (input, options) => importJdDocument(input, {
      embedder: embeddingModel,
      store: knowledgeStore,
    }, options),
    marketJdCatalog,
  }
}
