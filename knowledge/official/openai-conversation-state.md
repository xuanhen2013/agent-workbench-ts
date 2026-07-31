---
title: OpenAI Conversation State 最小事实集
owner: OpenAI
sourceUrl: https://developers.openai.com/api/docs/guides/conversation-state
verifiedAt: 2026-08-01
---

# OpenAI Conversation State 最小事实集

## 已核验事实

- 单次文本生成请求本身是独立且无状态的；多轮对话状态必须由应用或 OpenAI 的状态能力显式维护。
- 应用可以手工把历史 input 和先前 response 的 output 重新放入下一次请求。
- 对无状态的 reasoning model 请求，手工续传时应保留 `response.output` 中的全部 item，包括 reasoning item，而不是只保留可见文本。
- Responses API 可以使用 `previous_response_id` 把新响应链接到上一响应，形成连续对话。
- 使用 `previous_response_id` 不代表历史输入免费；链上的先前 input token 仍按 input token 计费。
- Response 对象默认保存 30 天；不希望保存时可设置 `store: false`。
- 上下文接近窗口或成本上限时，可以使用 compaction；官方同时提供服务端压缩和独立 compact endpoint。
- 对话状态、业务状态和长期用户记忆不是同一概念：Responses 的链路不能替代应用数据库或 LangGraph Checkpointer。

## 边界与常见误区

- `previous_response_id` 是服务端对话续接手段，不是免费的无限上下文，也不是业务数据库主键。
- 只保存 `output_text` 可能丢失 reasoning item、Tool Call 等协议信息，导致下一轮上下文不完整。
- `store: false` 控制 OpenAI 侧 Response 保存，不会自动删除应用自己保存的日志、State 或数据库数据。

## 来源章节

- Manually manage conversation state
- OpenAI APIs for conversation state / Passing context from the previous response
- Managing the context window / Compaction
