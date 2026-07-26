# agent-workbench-ts

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Configuration

Copy `.env.example` to `.env`, then supply the API keys. `OPENROUTER_URL` must be
the OpenAI-compatible API root, including `/v1`. The client uses
`client.responses.create()`, so the final request path is `/v1/responses`.

```bash
bun run typecheck
bun run lint
bun run test
```

## HTTP API

`GET /health` does not call a model and can be used to verify that the Bun/Hono
server is reachable.

`POST /api/react` invokes the native Responses ReAct graph:

```json
{ "message": "今天广州哪里适合旅游" }
```

`POST /api/plan` generates and executes a plan:

```json
{ "goal": "帮我规划广州一日游", "threadId": "optional-conversation-id" }
```

Every response contains `requestId`. Successful Agent responses additionally
contain `runId`, `threadId`, and `data`; invalid input and runtime failures use
the same JSON error envelope. Send `x-request-id` to supply your own request ID
for log correlation.

On Windows PowerShell, start with these requests before inspecting terminal
logs:

```powershell
Invoke-RestMethod http://localhost:7233/health

Invoke-RestMethod http://localhost:7233/api/react `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"message":"今天广州哪里适合旅游"}'
```

## Logs

Development logs use Pino's readable formatter. Each HTTP request has a `requestId`;
Agent routes also log a `runId` and `threadId`. Set `LOG_LEVEL=debug` only while
diagnosing a tool call. Prompts, encrypted reasoning, API keys, and full tool results
must not be logged; remove temporary `console.log` diagnostics before exposing the
server outside local development.
