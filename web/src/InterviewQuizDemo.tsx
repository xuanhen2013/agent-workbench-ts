import type {
  InterviewQuizView,
  MarketJdCard,
  PublicQuizRoundResult,
  QuizDifficulty,
  QuizProgressEvent,
  SelectedJdReference,
} from './api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import {
  continueInterviewQuizStream,
  createInterviewQuizStream,
  getInterviewQuiz,
  importInterviewJd,
  searchMarketJds,
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
        {result.sectionResults.map(section => (
          <div className="quiz-section-result" key={section.category.categoryId}>
            <div className="row section-heading">
              <strong>{section.category.name}</strong>
              <span>{`${section.correctCount} / ${section.total}`}</span>
            </div>
            {section.questionResults.map((question, index) => (
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
  const [jdTitle, setJdTitle] = useState('')
  const [jdContent, setJdContent] = useState('')
  const [marketQuery, setMarketQuery] = useState('Agent 前端')
  const [marketJds, setMarketJds] = useState<MarketJdCard[]>([])
  const [selectedJd, setSelectedJd] = useState<SelectedJdReference>()
  const [importedJd, setImportedJd] = useState<{
    jdDocumentId: string
    title: string
    chunkCount: number
  }>()
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [showSummary, setShowSummary] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<QuizProgressEvent>()
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
    const questions = view?.waitingQuestions?.sections.flatMap(section => section.questions) ?? []
    return questions.length > 0
      && questions.every(question => answers[question.questionId]?.length)
  }, [answers, view?.waitingQuestions])

  async function start() {
    setLoading(true)
    setError(undefined)
    setProgress({ phase: 'initializing', label: '正在启动 Agent' })
    try {
      const created = await createInterviewQuizStream({
        learnerId: getDemoLearnerId(),
        initialDifficulty: difficulty,
        maxRounds,
        ...(selectedJd ? { selectedJd } : {}),
      }, setProgress)
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
      setProgress(undefined)
    }
  }

  async function importJd() {
    if (!jdTitle.trim() || !jdContent.trim())
      return

    setLoading(true)
    setError(undefined)
    try {
      const imported = await importInterviewJd({
        learnerId: getDemoLearnerId(),
        title: jdTitle,
        content: jdContent,
      })
      setImportedJd(imported)
      setSelectedJd({
        source: 'user_upload',
        documentId: imported.jdDocumentId,
      })
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
    }
  }

  async function searchMarket() {
    if (!marketQuery.trim())
      return

    setLoading(true)
    setError(undefined)
    try {
      const response = await searchMarketJds(marketQuery)
      setMarketJds(response.items)
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
      const questions = round.sections.flatMap(section => section.questions)
      const nextView = await submitInterviewQuizAnswers(
        view.threadId,
        round.reviewId,
        questions.map(question => ({
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
    setProgress({ phase: 'initializing', label: '正在启动下一轮' })
    try {
      setView(await continueInterviewQuizStream(
        view.threadId,
        view.waitingResult.reviewId,
        setProgress,
      ))
    }
    catch (error) {
      setError(errorMessage(error))
    }
    finally {
      setLoading(false)
      setProgress(undefined)
    }
  }

  async function reset() {
    setView(undefined)
    setAnswers({})
    setShowSummary(false)
    setError(undefined)
    setProgress(undefined)
    setJdTitle('')
    setJdContent('')
    setMarketQuery('Agent 前端')
    setMarketJds([])
    setSelectedJd(undefined)
    setImportedJd(undefined)
    await navigate({ replace: true, search: {} })
  }

  const latestResult = view?.results.at(-1)

  return (
    <main className="shell quiz-shell">
      <header className="hero">
        <p className="eyebrow">AGENT WORKBENCH · CHAPTER 06E</p>
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
            <p>每个分类五题，最多三个分类，包含单选和多选。</p>
          </div>
          <div className="market-jd-picker">
            <label className="quiz-jd-field">
              搜索市场 JD
              <div className="market-jd-search-row">
                <input
                  value={marketQuery}
                  placeholder="例如：Agent 前端"
                  onChange={event => setMarketQuery(event.target.value)}
                />
                <button
                  className="secondary"
                  disabled={loading || marketQuery.trim().length < 2}
                  onClick={searchMarket}
                >
                  搜索 5 个岗位
                </button>
              </div>
            </label>
            {marketJds.length > 0 && (
              <div className="market-jd-list">
                {marketJds.map(jd => (
                  <button
                    className={`market-jd-card ${selectedJd?.source === 'market' && selectedJd.itemKey === jd.itemKey ? 'selected' : ''}`}
                    key={jd.itemKey}
                    type="button"
                    onClick={() => {
                      setSelectedJd({ source: 'market', itemKey: jd.itemKey })
                    }}
                  >
                    <strong>{jd.title}</strong>
                    <span>{jd.company}</span>
                    <small>{`${jd.location} · ${jd.salary}`}</small>
                    {jd.highlights.length > 0 && (
                      <span className="market-jd-highlights">
                        {jd.highlights.join(' · ')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="quiz-config-divider">或者粘贴自己的 JD</p>
          <label className="quiz-jd-field">
            JD 标题
            <input
              value={jdTitle}
              placeholder="例如：Agent 前端工程师"
              onChange={(event) => {
                setJdTitle(event.target.value)
                setImportedJd(undefined)
                if (selectedJd?.source === 'user_upload')
                  setSelectedJd(undefined)
              }}
            />
          </label>
          <label className="quiz-jd-field">
            JD 内容
            <textarea
              value={jdContent}
              placeholder="粘贴岗位职责和任职要求，导入后只提取 Agent 相关重点。"
              rows={6}
              onChange={(event) => {
                setJdContent(event.target.value)
                setImportedJd(undefined)
                if (selectedJd?.source === 'user_upload')
                  setSelectedJd(undefined)
              }}
            />
          </label>
          {importedJd && (
            <p className="notice jd-imported">
              已导入：
              {importedJd.title}
              （
              {importedJd.chunkCount}
              {' '}
              个资料片段）
            </p>
          )}
          <button
            className="secondary"
            disabled={loading || !jdTitle.trim() || !jdContent.trim()}
            onClick={importJd}
          >
            导入 JD
          </button>
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
          <button disabled={loading} onClick={start}>
            {selectedJd ? '使用已选 JD 开始答题' : '不带 JD 开始答题'}
          </button>
          {selectedJd && (
            <button
              className="text-button"
              type="button"
              onClick={() => setSelectedJd(undefined)}
            >
              取消 JD，按通用 Agent 方向出题
            </button>
          )}
        </section>
      )}

      {loading && <p className="notice">{progress?.label ?? 'Agent 正在处理…'}</p>}
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
            {view.waitingQuestions.sections.map(section => (
              <div className="quiz-section" key={section.category.categoryId}>
                <div className="quiz-section-title">
                  <h3>{section.category.name}</h3>
                  <span>{section.category.knowledgePoints.join(' · ')}</span>
                </div>
                {section.questions.map((question, index) => (
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
