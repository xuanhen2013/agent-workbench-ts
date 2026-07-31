---
name: question-authoring
description: 根据难度、策略和可信资料生成可由 TypeScript 确定性判分的 Agent 工程单选或多选题。
---

# Question Authoring

## Required workflow

1. 阅读当前轮 difficulty、strategy、wrongKnowledgePoints 和 previousQuestionStems。
2. 根据当前输入生成题目；如果调用方提供检索资料，只使用真实存在的资料，不伪造来源。
3. 每轮生成恰好五道题，题干不得与历史重复。
4. 输出必须符合调用方提供的 Structured Output Schema。
5. 如果当前轮提供了资料，不得把资料无法支持的推测写成正确答案。

## Resource routing

- 生成 single 题目前，读取 `references/single-choice.md`。
- 生成 multiple 题目前，读取 `references/multiple-choice.md`。
- strategy=remediate 时，读取 `references/remediation.md`。
- strategy=advance 时，读取 `references/advancement.md`。

## Deterministic boundary

模型只生成候选题。选项 ID、正确答案数量、重复题干等规则最终仍由 TypeScript 校验。
