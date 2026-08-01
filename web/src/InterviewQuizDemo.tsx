import type {
  InterviewQuizView,
  PublicQuizRoundResult,
  QuizDifficulty,
} from './api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  continueInterviewQuiz,
  createInterviewQuiz,
  getInterviewQuiz,
  submitInterviewQuizAnswers,
} from './api'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function difficultyLabel(difficulty: QuizDifficulty) {
  return {
    foundation: '基础',
    intermediate: '中级',
    advanced: '高级',
  }[difficulty]
}

function RoundResultCard({ result }: { result: PublicQuizRoundResult }) {
  const cacheRate = result.modelUsage?.inputTokens
    ? Math.round(
        result.modelUsage.cachedTokens
        / result.modelUsage.inputTokens
        * 100,
      )
    : 0

  return (
    <article className="quiz-result-card">
      <div className="row">
        <div>
          <p className="eyebrow">{`ROUND ${result.round}`}</p>
          <h2>{`${result.correctCount} / ${result.total}`}</h2>
        </div>
        <span className={`score ${result.allCorrect ? 'perfect' : ''}`}>
          {result.allCorrect ? '全部答对' : '继续加强'}
        </span>
      </div>

      <div className="quiz-result-list">
        {result.questionResults.map((question, index) => (
          <div
            className={`quiz-question-result ${question.isCorrect ? 'correct' : 'wrong'}`}
            key={question.questionId}
          >
            <strong>{`${index + 1}. ${question.stem}`}</strong>
            <span>{question.isCorrect ? '答对' : '答错'}</span>
            <small>
              你的选择：
              {' '}
              {question.selectedOptions
                .map(option => `${option.optionId}. ${option.text}`)
                .join('、')}
            </small>
          </div>
        ))}
      </div>

      {result.wrongKnowledgePoints.length > 0 && (
        <div className="knowledge-points">
          <strong>需要加强</strong>
          <div className="tag-list">
            {result.wrongKnowledgePoints.map(point => (
              <span className="tag" key={point}>{point}</span>
            ))}
          </div>
        </div>
      )}

      {result.modelUsage && (
        <details className="usage-details">
          <summary>Prompt Cache 指标</summary>
          <dl>
            <div>
              <dt>Input</dt>
              <dd>{result.modelUsage.inputTokens}</dd>
            </div>
            <div>
              <dt>Cached</dt>
              <dd>{result.modelUsage.cachedTokens}</dd>
            </div>
            <div>
              <dt>Cache Write</dt>
              <dd>{result.modelUsage.cacheWriteTokens}</dd>
            </div>
            <div>
              <dt>Hit Rate</dt>
              <dd>{`${cacheRate}%`}</dd>
            </div>
          </dl>
        </details>
      )}
    </article>
  )
}

export function InterviewQuizDemo() {
  const { threadId } = useSearch({ from: '/demos/interview-quiz' })
  const navigate = useNavigate({ from: '/demos/interview-quiz' })
  const [view, setView] = useState<InterviewQuizView>()
  const [difficulty, setDifficulty] = useState<QuizDifficulty>('foundation')
  const [maxRounds, setMaxRounds] = useState(3)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [showSummary, setShowSummary] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!threadId)
      return

    setLoading(true)
    getInterviewQuiz(threadId)
      .then(setView)
      .catch(error => setError(errorMessage(error)))
      .finally(() => setLoading(false))
  }, [threadId])

  useEffect(() => {
    setAnswers({})
    setShowSummary(false)
  }, [view?.waitingQuestions?.reviewId])

  const allAnswered = useMemo(() => {
    const questions = view?.waitingQuestions?.questions ?? []
    return questions.length > 0
      && questions.every(question => answers[question.questionId]?.length)
  }, [answers, view?.waitingQuestions])

  async function start() {
    setLoading(true)
    setError(undefined)
    try {
      const created = await createInterviewQuiz({
        learnerId: getDemoLearnerId(),
        initialDifficulty: difficulty,
        maxRounds,
      })
      setView(created)
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

  function selectOption(
    questionId: string,
    optionId: string,
    multiple: boolean,
  ) {
    setAnswers((current) => {
      if (!multiple)
        return { ...current, [questionId]: [optionId] }

      const selected = new Set(current[questionId] ?? [])
      if (selected.has(optionId))
        selected.delete(optionId)
      else
        selected.add(optionId)

      return { ...current, [questionId]: [...selected] }
    })
  }

  async function submitAnswers() {
    const round = view?.waitingQuestions
    if (!round || !allAnswered)
      return

    setLoading(true)
    setError(undefined)
    try {
      const nextView = await submitInterviewQuizAnswers(
        view.threadId,
        round.reviewId,
        round.questions.map(question => ({
          questionId: question.questionId,
          selectedOptionIds: answers[question.questionId] ?? [],
        })),
      )
      setView(nextView)
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }

  async function nextRound() {
    if (!view?.waitingResult)
      return

    setLoading(true)
    setError(undefined)
    try {
      setView(await continueInterviewQuiz(
        view.threadId,
        view.waitingResult.reviewId,
      ))
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }

  async function reset() {
    setView(undefined)
    setAnswers({})
    setShowSummary(false)
    setError(undefined)
    await navigate({ replace: true, search: {} })
  }

  const latestResult = view?.results.at(-1)

  return (
    <main className="shell quiz-shell">
      <header className="hero">
        <p className="eyebrow">AGENT WORKBENCH · CHAPTER 05</p>
        <h1>Agent Interview Quiz</h1>
        <p className="lead">
          Structured Planner 生成题目，TypeScript 判分，RePlan 根据你的薄弱点继续下一轮。
        </p>
      </header>

      {!view && (
        <section className="card quiz-config">
          <div>
            <p className="eyebrow">QUIZ CONFIG</p>
            <h2>开始 Agent 工程面试训练</h2>
            <p>每轮固定五题，包含单选和多选。</p>
          </div>
          <label>
            初始难度
            <select
              value={difficulty}
              onChange={event => setDifficulty(event.target.value as QuizDifficulty)}
            >
              <option value="foundation">基础</option>
              <option value="intermediate">中级</option>
              <option value="advanced">高级</option>
            </select>
          </label>
          <label>
            最大轮数
            <select
              value={maxRounds}
              onChange={event => setMaxRounds(Number(event.target.value))}
            >
              <option value={1}>1 轮</option>
              <option value={2}>2 轮</option>
              <option value={3}>3 轮</option>
            </select>
          </label>
          <button disabled={loading} onClick={start}>开始答题</button>
        </section>
      )}

      {loading && <p className="notice">Agent 正在处理…</p>}
      {error && <p className="notice error">{error}</p>}

      {view?.waitingQuestions && !showSummary && (
        <section className="card quiz-paper">
          <div className="row">
            <div>
              <p className="eyebrow">{`ROUND ${view.waitingQuestions.round}`}</p>
              <h2>{`${difficultyLabel(view.waitingQuestions.difficulty)}难度`}</h2>
            </div>
            <span className="status needs_input">等待答题</span>
          </div>

          <div className="quiz-questions">
            {view.waitingQuestions.questions.map((question, index) => (
              <fieldset className="quiz-question" key={question.questionId}>
                <legend>{`${index + 1}. ${question.stem}`}</legend>
                <p className="question-meta">
                  {question.type === 'multiple' ? '多选题' : '单选题'}
                  {' · '}
                  {question.knowledgePoint}
                </p>
                {question.options.map(option => (
                  <label className="quiz-option" key={option.optionId}>
                    <input
                      checked={(answers[question.questionId] ?? [])
                        .includes(option.optionId)}
                      name={question.questionId}
                      type={question.type === 'multiple' ? 'checkbox' : 'radio'}
                      onChange={() => selectOption(
                        question.questionId,
                        option.optionId,
                        question.type === 'multiple',
                      )}
                    />
                    <span>{`${option.optionId}. ${option.text}`}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>

          <button disabled={loading || !allAnswered} onClick={submitAnswers}>
            提交本轮答案
          </button>
        </section>
      )}

      {view && showSummary && (
        <section className="card quiz-summary">
          <div className="row">
            <div>
              <p className="eyebrow">SESSION RESULT</p>
              <h2>全部答题结果</h2>
            </div>
            <span className="status">{`${view.results.length} ROUNDS`}</span>
          </div>
          <div className="result-stack">
            {view.results.map(result => (
              <RoundResultCard key={result.round} result={result} />
            ))}
          </div>
          <div className="actions">
            {view.waitingResult && (
              <button className="secondary" onClick={() => setShowSummary(false)}>
                返回本轮结果
              </button>
            )}
            <button className="text-button" onClick={reset}>开始新的 Thread</button>
          </div>
        </section>
      )}

      {view && !showSummary && (view.waitingResult || view.status === 'completed') && latestResult && (
        <section className="card quiz-results">
          <RoundResultCard result={latestResult} />
          <div className="actions">
            <button className="secondary" onClick={() => setShowSummary(true)}>
              查看结果
            </button>
            {view.waitingResult && (
              <button disabled={loading} onClick={nextRound}>下一轮</button>
            )}
          </div>
          {view.status === 'completed' && (
            <p className="completion-note">已达到最大轮数，本次训练完成。</p>
          )}
        </section>
      )}

      {view?.status === 'failed' && view.error && (
        <section className="card result failure">
          <p className="eyebrow">{`FAILED · ${view.error.code}`}</p>
          <h2>面试题 Agent 执行失败</h2>
          <p>{view.error.message}</p>
          <button className="text-button" onClick={reset}>重新开始</button>
        </section>
      )}
    </main>
  )
}

function getDemoLearnerId(): string {
  const key = 'agent-workbench:quiz-learner-id'
  const existing = localStorage.getItem(key)
  if (existing)
    return existing

  const created = crypto.randomUUID()
  localStorage.setItem(key, created)
  return created
}
