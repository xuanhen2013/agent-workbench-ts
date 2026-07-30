import { Link, Outlet } from '@tanstack/react-router'

export function AppShell() {
  return (
    <>
      <nav className="topbar" aria-label="Demo navigation">
        <Link className="brand" to="/">Agent Workbench</Link>
        <div className="nav-links">
          <Link
            activeOptions={{ exact: true }}
            className="nav-link"
            to="/"
          >
            Demos
          </Link>
          <Link
            activeOptions={{ includeSearch: false }}
            className="nav-link"
            to="/demos/jokes"
          >
            Joke HITL
          </Link>
          <Link
            activeOptions={{ includeSearch: false }}
            className="nav-link"
            to="/demos/interview-quiz"
          >
            Agent Quiz
          </Link>
        </div>
      </nav>
      <Outlet />
    </>
  )
}

export function DemoHome() {
  return (
    <main className="shell home">
      <header className="hero">
        <p className="eyebrow">AGENT WORKBENCH</p>
        <h1>Agent Demo Lab</h1>
        <p className="lead">
          每个 Demo 对应一段独立的 Agent 工程能力。路由负责页面切换，
          Graph 和运行状态仍由各自的后端模块负责。
        </p>
      </header>

      <section className="demo-grid" aria-label="Available demos">
        <Link className="demo-card" to="/demos/jokes">
          <span className="demo-number">04</span>
          <div>
            <p className="eyebrow">LANGGRAPH · HITL</p>
            <h2>Joke Review Agent</h2>
            <p>体验 Checkpoint、Interrupt、动态选项和 Command Resume。</p>
          </div>
          <span className="demo-arrow" aria-hidden="true">→</span>
        </Link>
        <Link className="demo-card" to="/demos/interview-quiz">
          <span className="demo-number">05</span>
          <div>
            <p className="eyebrow">PLAN · REPLAN · PROMPT CACHE</p>
            <h2>Agent Interview Quiz</h2>
            <p>配置难度，完成多轮 Agent 选择题，并观察 RePlan 与缓存指标。</p>
          </div>
          <span className="demo-arrow" aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  )
}
