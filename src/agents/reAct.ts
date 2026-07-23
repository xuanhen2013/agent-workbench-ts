import type OpenAI from 'openai'
import type { Logger } from 'pino'
import type { OpenAiCompatibleClient } from '../clients/openai'
import type { ToolExecutor } from '../tools'
import { logger as appLogger } from '../logger'
import { ReActPrompt } from '../prompt/ReAct'

export class ReActAgent {
  llmClient: OpenAiCompatibleClient
  toolExecutor: ToolExecutor
  maxSteps: number = 5
  history: OpenAI.Responses.ResponseInput
  logger: Logger

  constructor({ llmClient, toolExecutor, maxSteps = 5, logger }: {
    llmClient: OpenAiCompatibleClient
    toolExecutor: ToolExecutor
    maxSteps?: number
    logger?: Logger
  }) {
    this.history = []
    this.llmClient = llmClient
    this.toolExecutor = toolExecutor
    this.maxSteps = maxSteps
    this.logger = logger ?? appLogger.child({ component: 'react-agent' })
  }

  async run(question: string): Promise<string> {
    this.history = [{ role: 'user', content: question }]
    let currentStep = 0

    while (currentStep < this.maxSteps) {
      const availableTools = this.toolExecutor.getAvailableTools()

      currentStep++

      this.logger.info({
        historyItems: this.history.length,
        step: currentStep,
        toolCount: availableTools.length,
      }, 'Agent 开始新一轮')

      const response = await this.llmClient.think({
        logger: this.logger.child({ step: currentStep }),
        systemPrompt: ReActPrompt,
        prompt: this.history,
        tools: availableTools,
      })

      const functionCalls = response.output.filter(item => item.type === 'function_call')

      this.logger.info({
        functionCalls: functionCalls.length,
        step: currentStep,
      }, 'Agent 已解析模型响应')

      // 当前 Agent 只注册 function 工具；这三类输出可作为下一轮 Responses input 复用。
      for (const item of response.output) {
        if (item.type === 'reasoning' || item.type === 'function_call' || item.type === 'message') {
          const { index: _index, ...inputItem } = item as typeof item & { index?: number }
          this.history.push(inputItem)
        }
      }

      if (functionCalls.length === 0) {
        const output = response.output_text.trim()
        if (!output) {
          throw new Error('模型既没有调用工具，也没有返回文本')
        }

        this.logger.info({ outputTextLength: output.length, step: currentStep }, 'Agent 已完成')
        return output
      }

      for (const call of functionCalls) {
        const toolLogger = this.logger.child({
          callId: call.call_id,
          step: currentStep,
          toolName: call.name,
        })

        toolLogger.info('开始执行工具')
        toolLogger.debug({ arguments: call.arguments }, '工具参数')

        try {
          const result = await this.toolExecutor.executeTool(call.name, call.arguments)
          this.history.push({ type: 'function_call_output', call_id: call.call_id, output: result })
          toolLogger.info({ resultLength: result.length }, '工具执行完成')
        }
        catch (error) {
          toolLogger.error({ err: error }, '工具执行失败')
          throw error
        }
      }
    }

    throw new Error(`Agent 超过最大执行轮数 ${this.maxSteps}`)
  }
}
