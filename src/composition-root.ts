import type { AppDeps } from '@/app'
import process from 'node:process'
import { MemorySaver } from '@langchain/langgraph'
import { createInterruptGraph } from '@/agent/interrupt/interrupt-graph'
import {
  createInterviewQuizFeature,
} from '@/agent/interview-quiz/composition'
import { OpenAIResponsesModel } from '@/agent/react/model-adapter'
import { createOpenAIResponsesExecutor } from '@/clients/openai'

/**
 * 进程级 Composition Root 只创建共享客户端并挂载各个独立功能。
 * InterviewQuiz 的题库、Memory、RAG、Subgraph 和 Graph 由功能自己组装。
 */
export async function createDefaultAppDeps(): Promise<AppDeps> {
  const openAIExecutor = createOpenAIResponsesExecutor()
  const interviewQuiz = await createInterviewQuizFeature({
    env: process.env,
    openAIExecutor,
  })
  const jokeGraph = createInterruptGraph({
    checkpointer: new MemorySaver(),
    model: new OpenAIResponsesModel(openAIExecutor),
  })

  return {
    interviewQuiz,
    jokeGraph,
  }
}
