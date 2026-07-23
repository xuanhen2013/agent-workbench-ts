import type OpenAI from 'openai'
import { END, MemorySaver, ReducedValue, START, StateGraph, StateSchema } from '@langchain/langgraph'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod/v4'
import { OpenAiCompatibleClient } from '@/clients/openai'
import { logger } from '@/logger'
import { ToolExecutor } from '@/tools'
import { QATool } from '@/tools/qa'
import { workflow as reActWorkflow } from './reAct'
import { historyValue } from './state'

const planTool = new ToolExecutor()
const qaTool = new QATool()

planTool.registerTool(qaTool.name, qaTool)

const openaiClient = new OpenAiCompatibleClient()
const planLogger = logger.child({ graph: 'plan' })

function previewText(text: string, maxLength = 240): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    }
  }

  return {
    errorName: typeof error,
    errorMessage: String(error),
  }
}

const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      objective: z.string(),
      doneWhen: z.array(z.string()),
    }),
  ).min(1).max(8),
})

export const planGraph = new StateGraph(new StateSchema({
  history: historyValue,
  // 目标
  goal: z.string().optional(),
  response: z.custom<OpenAI.Responses.Response>().nullable().default(null),
  step: z.number().int().nonnegative().default(1),
}), {
  output: new StateSchema({
    answer: PlanSchema,
  }),
})
  .addNode('start', (state, config) => {
    const nodeLogger = planLogger.child({
      node: 'start',
      threadId: config.configurable?.thread_id,
    })
    nodeLogger.info({ goal: previewText(state.goal ?? '') }, '开始制定计划')
    return { history: [{ role: 'user', content: state.goal }] }
  })
  .addNode('function_calls', async (state, config) => {
    if (!state.response) {
      return
    }

    const functionCalls = state.response.output.filter(item => item.type === 'function_call')
    const nodeLogger = planLogger.child({
      node: 'function_calls',
      step: state.step,
      threadId: config.configurable?.thread_id,
    })

    nodeLogger.info({
      functionCallCount: functionCalls.length,
      toolNames: functionCalls.map(call => call.name),
    }, 'Planner 请求工具')

    const toolOutputs: OpenAI.Responses.ResponseInputItem[] = []

    for (const call of functionCalls) {
      const toolLogger = nodeLogger.child({
        callId: call.call_id,
        toolName: call.name,
      })

      toolLogger.info({ input: previewText(call.arguments) }, '执行工具')

      try {
        const result = await planTool.executeTool(call.name, call.arguments)
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: result })
        toolLogger.info({ output: previewText(result) }, '工具返回结果')
      }
      catch (error) {
        toolLogger.error(errorDetails(error), '工具执行失败')
        throw error
      }
    }

    return { history: toolOutputs }
  })
  .addNode('plan', async (state, config) => {
    const nodeLogger = planLogger.child({
      node: 'plan',
      step: state.step,
      threadId: config.configurable?.thread_id,
    })

    const response = await openaiClient.think({
      prompt: state.history,
      systemPrompt: `
    你是 Planner。

    请根据用户目标生成一个可执行计划：
    - 计划包含 1 到 4 个步骤
    - 每个步骤都必须可以独立执行和验证
    - 每个步骤必须有明确的完成条件
    - 只生成计划，只能执行 ${QATool.name} 工具，其他工具只作为可用能力提供
    - 不要输出 Markdown 解释
      `,
      tools: planTool.getAvailableTools(),
      logger: nodeLogger,
      createOptions: {
        text: {
          format: zodTextFormat(PlanSchema, 'execution_plan'),
        },
      },
    })

    const responseHistory: OpenAI.Responses.ResponseInputItem[] = response.output.filter(
      item => ['reasoning', 'function_call', 'message'].includes(item.type),
    )

    nodeLogger.info({
      outputItemTypes: response.output.map(item => item.type),
      functionCallCount: response.output.filter(item => item.type === 'function_call').length,
    }, 'Planner 已处理模型响应')

    return { history: responseHistory, response, step: state.step + 1 }
  })
  .addNode('end', (state, config) => {
    const { response } = state
    if (!response) {
      throw new Error('缺少模型响应')
    }

    const planJson = PlanSchema.parse(JSON.parse(response.output_text))
    planLogger.info({
      node: 'end',
      threadId: config.configurable?.thread_id,
      goal: previewText(state.goal ?? ''),
      steps: planJson.steps.map(step => ({
        ...step,
        objective: previewText(step.objective),
        doneWhen: step.doneWhen.map(doneWhen => previewText(doneWhen)),
      })),
    }, '计划已生成')

    return { answer: planJson }
  })
  .addEdge(START, 'start')
  .addEdge('start', 'plan')
  .addEdge('function_calls', 'plan')
  .addEdge('end', END)
  .addConditionalEdges('plan', (state) => {
    if (!state.response) {
      throw new Error('判断下一步前缺少模型响应')
    }

    const functionCalls = state.response.output.filter(item => item.type === 'function_call')
    if (functionCalls.length === 0) {
      return 'end'
    }

    if (state.step >= 5) {
      throw new Error('达到最大执行步数')
    }

    return 'function_calls'
  })
  .compile({ checkpointer: new MemorySaver() })

export const planExecutor = new StateGraph(
  new StateSchema({
    plan: PlanSchema,
    history: historyValue,
    step: z.number().default(1),
  }),
  {
    output: new StateSchema({
      answer: z.string(),
    }),
  },
)
  .addNode('start', async (state, config) => {
    const { plan, step } = state

    const stepInfo = plan.steps[step - 1]

    if (!stepInfo) {
      throw new Error(`第${step}步不存在`)
    }

    planLogger.info({
      graph: 'plan-executor',
      node: 'start',
      step,
      threadId: config.configurable?.thread_id,
      objective: previewText(stepInfo.objective),
      doneWhen: stepInfo.doneWhen.map(doneWhen => previewText(doneWhen)),
    }, '开始执行计划步骤')

    return {
      history: [{
        role: 'user',
        content: `请执行第${step}步
        任务：${stepInfo.objective}
        完成标准输入：${stepInfo.doneWhen}
        请仅输出针对"当前步骤"的回答:
        `,
      }],
      step: step + 1,
    }
  })
  .addNode('react-anger', async (state, config) => {
    const output = await reActWorkflow.invoke({ history: state.history })

    planLogger.info({
      graph: 'plan-executor',
      node: 'react-agent',
      step: state.step - 1,
      threadId: config.configurable?.thread_id,
      output: previewText(output.answer),
    }, '计划步骤已完成')

    return { history: [{ role: 'assistant', content: output.answer }] }
  })
  .addNode('end', async (state, config) => {
    const response = await openaiClient.think({
      prompt: state.history.concat({ role: 'user', content: '总结任务完成情况汇报给我' }),
      systemPrompt: '你是一个执行大师，你只能调用当前已有的工具，不要去找用户确认而是按照目标直接完成',
      tools: [],
      logger: planLogger.child({
        graph: 'plan-executor',
        node: 'end',
        step: state.step,
        threadId: config.configurable?.thread_id,
      }),
    })

    const output = response.output_text.trim()
    if (!output) {
      throw new Error('模型既没有调用工具，也没有返回文本')
    }

    planLogger.info({
      graph: 'plan-executor',
      node: 'end',
      threadId: config.configurable?.thread_id,
      completedSteps: state.plan.steps.length,
      summary: previewText(output, 500),
    }, '计划执行完成')

    return { answer: output }
  })
  .addEdge(START, 'start')
  .addEdge('start', 'react-anger')
  .addEdge('end', END)
  .addConditionalEdges('react-anger', (state) => {
    planLogger.warn({
      graph: 'plan-executor',
      step: state.step,
      completedSteps: state.plan.steps.length,
    }, '进入下一步')

    if (state.plan.steps.length < state.step) {
      return 'end'
    }

    return 'start'
  })
  .compile({ checkpointer: new MemorySaver() })
