import type { OpenAI } from 'openai'
import { ReducedValue } from '@langchain/langgraph'
import { z } from 'zod'

export const historyValue = new ReducedValue(
  z.array(z.custom<OpenAI.Responses.ResponseInputItem>()).default(() => []),
  {
    reducer(
      left: OpenAI.Responses.ResponseInputItem[],
      right: OpenAI.Responses.ResponseInputItem[],
    ) {
      const _right = Array.isArray(right) ? right : [right]
      return [...left, ..._right].map((item) => {
        const { index, ...rest } = item
        return { ...rest }
      })
    },
  },
)
