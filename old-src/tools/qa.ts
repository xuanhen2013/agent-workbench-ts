import { z } from 'zod'

// 回答互动 tool
export class QATool {
  type = 'function' as const
  name: string = 'questionAndAnswer'
  description: string = '当存在需要确认的地方，提供问题和选项让用户进行选择答案，答案选项不能超过3个'
  strict: boolean = true
  parameters = {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '问题',
      },
      options: {
        type: 'array',
        description: '选项',
        items: {
          type: 'string',
        },
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  }

  schema: z.ZodType = z.object({
    question: z.string(),
    options: z.array(z.string()),
  })

  async fn({ question, options }: z.infer<typeof this.schema>) {
    // 无脑回答第一个答案回去
    return `question: ${question}\n answer: ${options[0]}`
  }
}
