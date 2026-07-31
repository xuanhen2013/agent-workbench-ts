---
title: Cloudflare AI Search 最小事实集
owner: Cloudflare
sourceUrls:
  - https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/
  - https://developers.cloudflare.com/ai-search/api/items/rest-api/
  - https://developers.cloudflare.com/ai-search/api/search/rest-api/
verifiedAt: 2026-08-01
---

# Cloudflare AI Search 最小事实集

## 已核验事实

- AI Search 是托管搜索服务，可连接网站、R2 Bucket，或把文件上传到内置存储后进行自然语言检索。
- Indexing 是异步过程；它在连接数据源或通过 Items API 上传文件后自动开始。
- 索引流程包含内容摄取、文本提取、Chunking、Embedding、可选关键词索引以及存储。
- Querying 是由用户查询触发的同步过程，可使用向量检索、关键词检索或两者结合来返回相关内容。
- Search endpoint 只返回检索内容，适合应用自行生成答案；Chat Completions endpoint 会额外生成文本回答。
- Search REST API 使用 OpenAI-compatible `messages` 作为查询输入。
- Search 结果的 `result.chunks` 包含 Chunk 的 `id`、`text`、`score` 和来源 `item` 等信息。
- `ai_search_options.retrieval.max_num_results` 可限制返回 Chunk 数量。
- Items API 通过 `POST /accounts/{account_id}/ai-search/instances/{id}/items` 上传文件，multipart 字段名为 `file`。
- Items API 可列出条目；状态可能是 `queued`、`running`、`completed`、`error`、`skipped` 或 `outdated`。
- 上传请求成功只代表文件已接收，不代表索引完成或已经能够被搜索。
- REST 请求需要 API Token；现行文档要求 Token 同时具备 `AI Search:Edit` 与 `AI Search:Run` 权限。

## 边界与常见误区

- AI Search 可以代管 Chunking、Embedding 和 Index，但资料可信度分级仍由应用负责。
- 相似度高不等于事实一定正确；当前项目只把经过核验并上传到指定实例的官方资料视为 `answer_evidence`。
- 文件 frontmatter 只提供追溯信息，不会自动授予资料可信角色；证据角色由受信任的 Adapter 配置决定。

## 来源章节

- How AI Search works / How indexing works / How querying works
- Items REST API / Items / Upload / List
- Search REST API / Search and chat / Search
