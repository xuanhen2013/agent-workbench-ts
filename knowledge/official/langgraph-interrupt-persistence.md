---
title: LangGraph Interrupt 与 Persistence 最小事实集
owner: LangChain
sourceUrls:
  - https://docs.langchain.com/oss/javascript/langgraph/interrupts
  - https://docs.langchain.com/oss/javascript/langgraph/persistence
verifiedAt: 2026-08-01
---

# LangGraph Interrupt 与 Persistence 最小事实集

## 已核验事实

- `interrupt(value)` 在 Node 内暂停 Graph，并把一个可 JSON 序列化的 payload 暴露给调用方。
- 暂停结果通过 `__interrupt__` 暴露；恢复时再次调用 Graph，并传入 `new Command({ resume: value })`。
- Resume value 会成为暂停 Node 中 `interrupt()` 调用的返回值。
- Interrupt 需要 Checkpointer 保存 Graph State；生产环境应使用可持久化的 Checkpointer。
- `thread_id` 是 Checkpointer 找回同一条执行状态的指针；复用同一 ID 恢复同一 Thread，新 ID 开始新 Thread。
- Node 在 Resume 时会从开头重新执行，不会从 `interrupt()` 下一行直接继续。
- 因为 Node 会重放，`interrupt()` 前的副作用应幂等，或移动到 Interrupt 后、独立 Node 中执行。
- Interrupt payload 应保持可序列化，并避免在同一 Node 的版本升级中随意改变多个 Interrupt 的顺序。
- Checkpointer 保存单个 Thread 的 Graph State 快照，适合短期状态、HITL、恢复和容错。
- Store 保存 Graph State 之外、可跨 Thread 的应用数据，适合用户偏好、事实和长期记忆。
- `MemorySaver`/`InMemorySaver` 只保存在进程内存中，进程重启后数据会丢失。

## 边界与常见误区

- `thread_id` 是恢复游标，不等于用户身份、授权凭证或 Web API 的安全校验。
- Checkpointer 不等于 SQL 长期 Memory；前者面向当前 Thread 的执行快照，后者面向跨 Session 的业务数据。
- Resume 输入应使用 `Command({ resume })`；普通的新一轮对话输入应传普通对象，不应滥用只有 `update` 的 Command。

## 来源章节

- Interrupts / Pause using interrupt / Resuming interrupts
- Interrupts / Rules of interrupts / Side effects called before interrupt must be idempotent
- Persistence / Checkpointers / Stores / Checkpointer vs. store
