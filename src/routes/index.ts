import { Hono } from 'hono'
import { planExecutor, planGraph } from '@/graphs/plan'
import { workflow as reActWorkflow } from '@/graphs/reAct'
import { ReActAgent } from '../agents/reAct'
import { OpenAiCompatibleClient } from '../clients/openai'
import { logger } from '../logger'
import { ToolExecutor } from '../tools'
import { SerpApiTool } from '../tools/serpapi'
import { TavilyTool } from '../tools/tavily'
import { WttrTool } from '../tools/wttr'

const openAiClient = new OpenAiCompatibleClient()

export const IndexRouters = new Hono()

// IndexRouters.get('/1-3-2', async (c) => {
//   try {
//     const userPrompt = c.req.query('prompt')?.trim() || DEFAULT_USER_PROMPT
//     const promptHistory = [`用户请求: ${userPrompt}`]

//     for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
//       const output = await openAiClient.generate(promptHistory.join('\n'), AGENT_SYSTEM_PROMPT)

//       const actionLine = output
//         .split(/\r?\n/)
//         .find(line => line.startsWith('Action:'))
//       const action = actionLine?.slice('Action:'.length).trim()
//       if (!action) {
//         throw new Error('模型输出中没有合法的 Action')
//       }

//       const finalAnswer = action.match(/^Finish\[(.*)\]$/s)?.[1]?.trim()
//       if (finalAnswer) {
//         return c.json({ result: finalAnswer })
//       }

//       const toolCall = action.match(/^([a-z_]\w*)\s*\((.*)\)$/is)
//       const toolName = toolCall?.[1]
//       const rawArguments = toolCall?.[2]
//       if (!toolName || rawArguments === undefined) {
//         throw new Error(`无法解析 Action: ${action}`)
//       }

//       const argumentPattern = /(\w+)\s*=\s*"([^"]*)"/g
//       const matches = [...rawArguments.matchAll(argumentPattern)]
//       const remaining = rawArguments.replace(argumentPattern, '').replaceAll(',', '').trim()
//       if (remaining) {
//         throw new Error(`无法解析工具参数: ${rawArguments}`)
//       }

//       const args: Record<string, string> = {}
//       for (const match of matches) {
//         const name = match[1]
//         const value = match[2]

//         if (!name || value === undefined) {
//           throw new Error(`无法解析工具参数: ${rawArguments}`)
//         }
//         if (Object.hasOwn(args, name)) {
//           throw new Error(`工具参数 ${name} 重复`)
//         }

//         args[name] = value
//       }

//       let observation: string
//       if (toolName === 'getWeather') {
//         const city = args.city?.trim()
//         if (!city) {
//           throw new Error('getWeather 缺少 city 参数')
//         }
//         observation = await getWeather(city)
//       }
//       else if (toolName === 'getAttraction') {
//         const city = args.city?.trim()
//         const weather = args.weather?.trim()
//         if (!city || !weather) {
//           throw new Error('getAttraction 缺少 city 或 weather 参数')
//         }
//         observation = await getAttraction(city, weather)
//       }
//       else {
//         throw new Error(`未知的工具: ${toolName}`)
//       }

//       promptHistory.push(`Observation: ${observation}`)
//     }

//     throw new Error(`Agent 在 ${MAX_AGENT_STEPS} 步内未完成任务`)
//   }
//   catch (error) {
//     const message = error instanceof Error ? error.message : 'Agent 执行失败'
//     console.error('Agent request failed:', message)
//     return c.json({ error: message }, 500)
//   }
// })

IndexRouters.get('/4-2-2', async (c) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
  const requestLogger = logger.child({ requestId, route: '/4-2-2' })
  const toolExecutor = new ToolExecutor()

  const serpApiTool = new SerpApiTool()
  const tavilyTool = new TavilyTool()
  const wttrTool = new WttrTool()

  const reactAgent = new ReActAgent({
    llmClient: openAiClient,
    logger: requestLogger.child({ component: 'react-agent' }),
    toolExecutor,
  })

  toolExecutor.registerTool(serpApiTool.name, serpApiTool)
  toolExecutor.registerTool(tavilyTool.name, tavilyTool)
  toolExecutor.registerTool(wttrTool.name, wttrTool)

  requestLogger.info({
    toolNames: toolExecutor.getAvailableTools().map(tool => tool.name),
  }, 'Agent 请求开始')

  try {
    const result = await reactAgent.run('英伟达最新的GPU型号是什么')
    requestLogger.info({ resultLength: result.length }, 'Agent 请求完成')
    return c.json({ result })
  }
  catch (error) {
    requestLogger.error({ err: error }, 'Agent 请求失败')
    return c.json({ error: '执行失败' }, 500)
  }
})

IndexRouters.get('/react-agent', async (c) => {
  const result = await reActWorkflow.invoke({
    history: [{ role: 'user', content: '今天广州哪里适合旅游' }],
    step: 1,
  })
  return c.json({ result })
})

IndexRouters.get('/plan-agent', async (c) => {
  const plan = await planGraph.invoke(
    { goal: '帮我写一个制定明天单人前往广州游玩的执行步骤，我需要怎么一步步制定自己的游玩计划' },
    { configurable: { thread_id: String(Date.now()) } },
  )
  const result = await planExecutor.invoke(
    { plan: plan.answer },
    { configurable: { thread_id: String(Date.now()) } },
  )
  return c.json({ result })
})
