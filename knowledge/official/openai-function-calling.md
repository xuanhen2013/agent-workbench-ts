---
title: OpenAI Function Calling 最小事实集
owner: OpenAI
sourceUrl: https://developers.openai.com/api/docs/guides/function-calling
verifiedAt: 2026-08-01
---

# OpenAI Function Calling 最小事实集

## 已核验事实

- Function Calling（也称 Tool Calling）让模型请求应用提供的外部数据或动作；工具不是在模型内部执行的。
- 一轮完整 Tool Calling 通常包含五步：请求时提供工具、模型返回 Tool Call、应用执行工具、应用回传 Tool Output、模型给出最终回答或继续请求工具。
- Function Tool 使用 JSON Schema 描述名称、用途和参数，应用仍需校验参数并决定是否真的执行。
- Tool Output 必须通过对应的 `call_id` 与 Tool Call 关联。
- `tool_choice` 可以控制模型是否允许、必须或只允许调用指定工具。
- Tool 的名称、描述、参数和输出含义应清晰；应用已经知道的参数应由代码补入，不应让模型猜测或重复填写。
- 官方建议一轮开始时可用 Function 数量尽量少于 20；这是软建议，不是协议上限。
- `strict: true` 可提高参数遵循 Schema 的可靠性。
- Strict Mode 要求每个 object 设置 `additionalProperties: false`，并把 `properties` 中的字段全部列入 `required`。
- 逻辑上的可选字段可以通过允许 `null` 的联合类型表达。

## 边界与常见误区

- 模型返回 Tool Call 不等于工具已经执行，也不等于应用已经授权执行。
- Strict Mode 提高结构可靠性，但不保证参数代表的事实正确，也不替代权限、超时、重试和幂等控制。
- “少于 20 个工具”是上下文和选择准确率建议，不是超出就必然报错。

## 来源章节

- How it works / The tool calling flow
- Defining functions / Best practices for defining functions
- Additional configurations / Tool choice
- Strict mode
