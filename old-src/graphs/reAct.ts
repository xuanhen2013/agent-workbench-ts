import type OpenAI from 'openai'
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { OpenAiCompatibleClient } from '@/clients/openai'
import { logger } from '@/logger'
import { ReActPrompt } from '@/prompt/ReAct'
import { ToolExecutor } from '@/tools'
import { SerpApiTool } from '@/tools/serpapi'
import { TavilyTool } from '@/tools/tavily'
import { WttrTool } from '@/tools/wttr'
import { historyValue } from './state'

const toolExecutor = new ToolExecutor()
const serpApiTool = new SerpApiTool()
const tavilyTool = new TavilyTool()
const wttrTool = new WttrTool()
toolExecutor.registerTool(serpApiTool.name, serpApiTool)
toolExecutor.registerTool(tavilyTool.name, tavilyTool)
toolExecutor.registerTool(wttrTool.name, wttrTool)

const openaiClient = new OpenAiCompatibleClient()

const AgentState = new StateSchema({
  history: historyValue,
  step: z.number().int().nonnegative().default(0),
  response: z.custom<OpenAI.Responses.Response>().nullable().default(null),
  answer: z.string().optional(),
})

const AgentOutput = new StateSchema({
  answer: z.string(),
})

export const workflow = new StateGraph(AgentState, {
  output: AgentOutput,
})
  .addNode('function_calls', async (state) => {
    if (!state.response) {
      throw new Error('执行工具前缺少模型响应')
    }

    const functionCalls = state.response.output.filter(item => item.type === 'function_call')

    const toolOutputs: OpenAI.Responses.ResponseInputItem[] = []

    for (const call of functionCalls) {
      const toolLogger = logger.child({
        callId: call.call_id,
        step: state.step,
        toolName: call.name,
        component: 'react-agent'
      })

      toolLogger.info('开始执行工具')
      toolLogger.debug({ arguments: call.arguments }, '工具参数')

      try {
        const result = await toolExecutor.executeTool(call.name, call.arguments)
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: result })
        toolLogger.info({ resultLength: result.length }, '工具执行完成')
      }
      catch (error) {
        toolLogger.error({ err: error }, '工具执行失败')
        throw error
      }
    }

    return { history: toolOutputs }
  })
  .addNode('agent', async (state) => {
    const response = await openaiClient.think({
      logger: logger.child({ step: state.step, component: 'react-agent' }),
      systemPrompt: ReActPrompt,
      prompt: state.history,
      tools: toolExecutor.getAvailableTools(),
    })

    const responseHistory = response.output.filter(
      item => ['reasoning', 'function_call', 'message'].includes(item.type),
    )

    return { response, step: state.step + 1, history: responseHistory }
  })
  .addNode('end', async (state) => {
    if (!state.response) {
      throw new Error('结束 Agent 前缺少模型响应')
    }

    const output = state.response.output_text.trim()
    if (!output) {
      throw new Error('模型既没有调用工具，也没有返回文本')
    }
    return { answer: output }
  })
  .addNode('failed', async () => {
    return { answer: '模型执行失败, 超过最大上限' }
  })
  .addEdge(START, 'agent')
  .addEdge('function_calls', 'agent')
  .addConditionalEdges('agent', (state) => {
    if (!state.response) {
      throw new Error('判断下一步前缺少模型响应')
    }

    const functionCalls = state.response.output.filter(item => item.type === 'function_call')
    if (functionCalls.length === 0) {
      return 'end'
    }

    if (state.step >= 5) {
      return 'failed'
    }

    return 'function_calls'
  })
  .addEdge('end', END)
  .addEdge('failed', END)
  .compile()
