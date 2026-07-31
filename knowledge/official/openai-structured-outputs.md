---
title: OpenAI Structured Outputs 最小事实集
owner: OpenAI
sourceUrl: https://developers.openai.com/api/docs/guides/structured-outputs
verifiedAt: 2026-08-01
---

# OpenAI Structured Outputs 最小事实集

## 已核验事实

- JSON Mode 只保证输出是可解析的 JSON；Structured Outputs 进一步保证输出遵循指定 JSON Schema。
- 官方建议在适用时优先使用 Structured Outputs，而不是只使用 JSON Mode。
- Responses API 使用 `text.format` 配置结构化文本输出，格式类型为 `json_schema`。
- Structured Outputs 只支持 JSON Schema 的一个子集，不能假设任意 JSON Schema 关键字都可用。
- 支持的基本结构包括 string、number、integer、boolean、object、array、enum 和受约束的 `anyOf`。
- 根 Schema 必须是 object，不能在根节点使用 `anyOf`；Zod discriminated union 常生成根级 `anyOf`，需要留意。
- 所有字段必须列入 `required`；逻辑可选值可通过与 `null` 的联合类型表达。
- 每个 object 都必须设置 `additionalProperties: false`。
- 模型拒绝回答时可能返回 `refusal`，拒绝内容不一定符合业务 Schema，应用需要单独处理。
- Schema 合法不等于内容事实正确；Structured Outputs 解决结构契约，不解决幻觉和来源可信度。

## 边界与常见误区

- `JSON.parse()` 成功不能替代 Structured Outputs 或应用侧 Zod 边界校验。
- Structured Outputs 不会自动调用工具；Tool Calling 和最终结构化文本输出是两个不同协议位置。
- 内部可信对象不需要在每个 Node 反复 `.parse()`；应在模型或 HTTP 数据进入可信区时校验一次。

## 来源章节

- Structured Outputs vs JSON mode
- Examples / Tips for your JSON Schema
- Supported schemas
- JSON mode
