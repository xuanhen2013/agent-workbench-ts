import type { AppDeps } from '@/app'
import { MemorySaver } from '@langchain/langgraph'
import { createInterruptGraph } from '@/agent/interrupt/interrupt-graph'
import { createInterviewQuizGraph } from '@/agent/interview-quiz/interview-quiz-graph'
import { QuizPlanner } from '@/agent/interview-quiz/planning'
import { OpenAIResponsesModel } from '@/agent/react/model-adapter'
import { createOpenAIModelClient } from '@/clients/openai'

/** 正式进程只创建一次 Graph 和 MemorySaver，所有 Joke Route 共享同一状态仓库。 */
export function createDefaultAppDeps(): AppDeps {
  const { client, model } = createOpenAIModelClient()
  const jokeGraph = createInterruptGraph({
    checkpointer: new MemorySaver(),
    model: new OpenAIResponsesModel(client, model),
  })
  const interviewQuizGraph = createInterviewQuizGraph({
    checkpointer: new MemorySaver(),
    planner: new QuizPlanner(client, model),
  })

  return { interviewQuizGraph, jokeGraph }
}
