# agent-workbench-ts

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Configuration

Copy `.env.example` to `.env`, then supply the API keys. `OPENROUTER_URL` must be
the OpenAI-compatible API root, including `/v1`. The client uses
`client.responses.create()`, so the final request path is `/v1/responses`.

```bash
bun x tsc --noEmit
bun run lint
```

## Logs

Development logs use Pino's readable formatter. Each Agent request has a `requestId`
and logs its step, model duration, tool call, and result length. Set `LOG_LEVEL=debug`
to include tool arguments; prompts, encrypted reasoning, API keys, and full tool results
are never logged.
