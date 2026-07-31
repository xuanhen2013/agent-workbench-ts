---
title: LangGraph Graph API 最小事实集
owner: LangChain
sourceUrl: https://docs.langchain.com/oss/javascript/langgraph/graph-api
verifiedAt: 2026-08-01
---

# LangGraph Graph API 最小事实集

## 已核验事实

- LangGraph 用图表示 Agent Workflow，核心组成是 State、Node 和 Edge。
- State 是当前应用快照，由 State Schema 和各字段的 reducer 行为共同定义。
- Node 接收当前 State，执行计算或副作用，并返回 State 的局部更新；不必返回完整 State。
- Edge 决定下一个执行的 Node；固定 Edge 表示固定转移，Conditional Edge 根据 State 选择分支。
- Node 和 Edge 本质上都是函数，里面既可以调用 LLM，也可以只执行确定性 TypeScript 代码。
- `StateGraph` 是 Graph API 的主要图类型，使用前必须调用 `.compile()`。
- 编译会进行基础图结构检查，也是配置 Checkpointer 等运行能力的位置。
- 未配置自定义 reducer 的字段默认采用覆盖语义；需要累积的字段应显式定义 reducer。
- Graph 可以定义内部总 State，并用单独的 input/output schema 限制调用入口与最终返回值。
- `Command` 可组合状态更新与动态路由；仅需路由时可以使用 Conditional Edge。

## 边界与常见误区

- 把 Node 函数拆到多个文件不等于拆成多个 StateGraph 或 Subgraph。
- StateGraph 负责流程与状态推进，不自动提供 Tool 权限、重试、业务错误映射或长期用户记忆。
- Input/output/private schema 限制读取与 `invoke` 返回值，但 private channel 默认不等于流式输出中的安全脱敏。

## 来源章节

- Graphs / StateGraph / Compiling your graph
- State / Schema / Multiple schemas / Reducers
- Nodes
- Edges / Conditional edges
- Command
