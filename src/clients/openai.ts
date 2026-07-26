import process from 'node:process'
import OpenAI from 'openai'
import { requiredEnv } from '../config'

export type OpenAIModelClient = Readonly<{
  client: OpenAI
  model: string
}>

export type OpenAIResponseInputItem = OpenAI.Responses.ResponseInputItem

export type OpenAIResponseFunctionTool = OpenAI.Responses.FunctionTool

export type OpenAIResponse = OpenAI.Responses.Response

export function createOpenAIModelClient(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIModelClient {
  const baseURL = requiredEnv(env, 'OPENAI_BASE_URL')
  const apiKey = requiredEnv(env, 'OPENAI_API_KEY')
  const model = requiredEnv(env, 'OPENAI_DEFAULT_MODAL')

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: 60_000,
  })

  return {
    client,
    model,
  }
}
