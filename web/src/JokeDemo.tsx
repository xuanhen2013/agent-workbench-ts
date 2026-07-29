import type { JokeDecision, JokeView } from './api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { createJoke, getJoke, resumeJoke } from './api'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function JokeDemo() {
  const { threadId } = useSearch({ from: '/demos/jokes' })
  const navigate = useNavigate({ from: '/demos/jokes' })
  const [jokeView, setJokeView] = useState<JokeView>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    // 刷新页面时只用 Route Search 中的 threadId 读取后端 Checkpoint。
    if (!threadId)
      return

    setLoading(true)
    getJoke(threadId)
      .then(setJokeView)
      .catch(error => setError(errorMessage(error)))
      .finally(() => setLoading(false))
  }, [threadId])

  async function start() {
    setLoading(true)
    setError(undefined)
    try {
      const created = await createJoke()
      setJokeView(created)
      await navigate({
        replace: true,
        search: { threadId: created.threadId },
      })
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }

  async function decide(result: JokeDecision) {
    if (!jokeView?.waiting)
      return

    setLoading(true)
    setError(undefined)
    try {
      const resumed = await resumeJoke(
        jokeView.threadId,
        jokeView.waiting.reviewId,
        result,
      )
      setJokeView(resumed)
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }

  async function reset() {
    setJokeView(undefined)
    setError(undefined)
    await navigate({ replace: true, search: {} })
  }

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">AGENT WORKBENCH · CHAPTER 04</p>
        <h1>Joke Review Agent</h1>
        <p className="lead">
          让 Agent 讲一个笑话，在 LangGraph Interrupt 处等你评价，再从同一条
          Thread 继续执行。
        </p>
      </header>

      {!jokeView && (
        <section className="card start-card">
          <div>
            <p className="eyebrow">HUMAN IN THE LOOP</p>
            <h2>准备好听笑话了吗？</h2>
            <p>创建后，后端会生成 threadId，并把暂停点保存到 MemorySaver。</p>
          </div>
          <button disabled={loading} onClick={start}>讲一个笑话</button>
        </section>
      )}

      {loading && <p className="notice">Agent 正在处理…</p>}
      {error && <p className="notice error">{error}</p>}

      {jokeView && (
        <section className="card conversation" aria-live="polite">
          <div className="row">
            <div>
              <p className="eyebrow">THREAD</p>
              <code>{jokeView.threadId}</code>
            </div>
            <span className={`status ${jokeView.status}`}>
              {jokeView.status}
            </span>
          </div>

          {jokeView.joke && (
            <div className="joke">
              <span className="round">{`ROUND ${jokeView.round}`}</span>
              <blockquote>{jokeView.joke}</blockquote>
            </div>
          )}

          {jokeView.waiting && (
            <div className="review">
              <h2>{jokeView.waiting.question}</h2>
              <p>你的选择会作为 Command resume 的值，恢复当前暂停节点。</p>
              <div className="actions">
                {jokeView.waiting.options.map(option => (
                  <button
                    className={option.value === 'rejected' ? 'secondary' : undefined}
                    disabled={loading}
                    key={option.value}
                    onClick={() => decide(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {jokeView.result && (
            <div className="result success">
              <p className="eyebrow">COMPLETED</p>
              <h2>这条笑话通过了你的审核</h2>
              <p>
                Agent 在第
                {' '}
                {jokeView.result.rounds}
                {' '}
                轮完成，Checkpoint 中保存的是最终状态。
              </p>
            </div>
          )}

          {jokeView.status === 'failed' && jokeView.error && (
            <div className="result failure">
              <p className="eyebrow">{`FAILED · ${jokeView.error.code}`}</p>
              <h2>这次没能逗笑你</h2>
              <p>{jokeView.error.message}</p>
            </div>
          )}

          <button className="text-button" disabled={loading} onClick={reset}>
            开始一条新 Thread
          </button>
        </section>
      )}
    </main>
  )
}
