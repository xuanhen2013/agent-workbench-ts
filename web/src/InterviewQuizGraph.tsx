import type { Edge, Node, NodeProps } from '@xyflow/react'
import type {
  InterviewQuizView,
  QuizActivityEvent,
  QuizProgressEvent,
} from './api'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { useEffect, useMemo, useRef } from 'react'

type GraphNodeId
  = | 'initialize'
    | 'load_memory'
    | 'load_jd_context'
    | 'select_categories'
    | 'planning'
    | 'load_question_history'
    | 'retrieve_question_signals'
    | 'plan_round'
    | 'call_model'
    | 'check_round_budget'
    | 'execute_tools'
    | 'append_tool_outputs'
    | 'planner_finish'
    | 'collect_section'
    | 'persist_questions'
    | 'answer_questions'
    | 'verify'
    | 'persist_memory'
    | 'wait_next_round'
    | 'replan'
    | 'finish'
    | 'failed'

type ScopeNodeId = 'parent_graph' | 'planning_subgraph' | 'tool_loop'

interface InterviewQuizGraphProps {
  view?: InterviewQuizView
  progress?: QuizProgressEvent
  activities: readonly QuizActivityEvent[]
  loading: boolean
}

interface QuizFlowNodeData extends Record<string, unknown> {
  label: string
  detail: string
  tone?: 'default' | 'interrupt' | 'terminal' | 'error'
}

type QuizFlowNode = Node<QuizFlowNodeData, 'quizNode'>
type FlowNode = QuizFlowNode | Node<{ label: string }, 'group'>

const PHASE_NODE_MAP: Record<string, GraphNodeId> = {
  initializing: 'initialize',
  loading_memory: 'load_memory',
  loading_jd: 'load_jd_context',
  selecting_categories: 'select_categories',
  generating_category: 'planning',
  loading_question_history: 'load_question_history',
  retrieving_question_signals: 'retrieve_question_signals',
  starting_planner: 'plan_round',
  calling_model: 'call_model',
  checking_tool_budget: 'check_round_budget',
  executing_tools: 'execute_tools',
  processing_tool_results: 'append_tool_outputs',
  validating_model_output: 'planner_finish',
  planner_failed: 'failed',
  collecting_section: 'collect_section',
  saving_questions: 'persist_questions',
  waiting_for_answers: 'answer_questions',
  grading: 'verify',
  saving_memory: 'persist_memory',
  waiting_for_next_round: 'wait_next_round',
  replanning: 'replan',
  completed: 'finish',
}

const TOOL_LOOP_NODE_IDS = new Set<GraphNodeId>([
  'call_model',
  'check_round_budget',
  'execute_tools',
  'append_tool_outputs',
  'planner_finish',
])

const PLANNING_NODE_IDS = new Set<GraphNodeId>([
  'planning',
  'load_question_history',
  'retrieve_question_signals',
  'plan_round',
  ...TOOL_LOOP_NODE_IDS,
])

function scopeNode(
  id: ScopeNodeId,
  label: string,
  position: { x: number, y: number },
  size: { width: number, height: number },
  options: { parentId?: ScopeNodeId, className: string },
): FlowNode {
  return {
    id,
    type: 'group',
    position,
    data: { label },
    className: `quiz-flow-scope ${options.className}`,
    style: size,
    selectable: false,
    draggable: false,
    ...(options.parentId
      ? { parentId: options.parentId, extent: 'parent' as const }
      : {}),
  }
}

function graphNode(
  id: GraphNodeId,
  label: string,
  detail: string,
  position: { x: number, y: number },
  parentId: ScopeNodeId,
  tone: QuizFlowNodeData['tone'] = 'default',
): FlowNode {
  return {
    id,
    type: 'quizNode',
    position,
    parentId,
    extent: 'parent',
    data: { label, detail, tone },
    draggable: false,
  }
}

// 固定布局比自动布局更适合这个教学 Demo：节点不会在每次 SSE 更新时跳动，
// Parent、Planning Subgraph 和 Tool Loop 的边界也能一直保持在同一位置。
const BASE_NODES: FlowNode[] = [
  scopeNode(
    'parent_graph',
    'Interview Quiz Graph / Parent',
    { x: 0, y: 0 },
    { width: 780, height: 2730 },
    { className: 'quiz-flow-scope-parent' },
  ),
  scopeNode(
    'planning_subgraph',
    'Planning Subgraph',
    { x: 60, y: 430 },
    { width: 660, height: 1250 },
    { parentId: 'parent_graph', className: 'quiz-flow-scope-planning' },
  ),
  scopeNode(
    'tool_loop',
    'Reusable Tool Loop',
    { x: 50, y: 550 },
    { width: 560, height: 640 },
    { parentId: 'planning_subgraph', className: 'quiz-flow-scope-tool' },
  ),

  graphNode('initialize', 'initialize', '初始化会话与轮次', { x: 295, y: 65 }, 'parent_graph'),
  graphNode('load_memory', 'load_memory', '读取跨 Session 薄弱点', { x: 295, y: 175 }, 'parent_graph'),
  graphNode('load_jd_context', 'load_jd_context', '加载用户或市场 JD', { x: 295, y: 285 }, 'parent_graph'),
  graphNode('select_categories', 'select_categories', '确定本轮题目分类', { x: 295, y: 395 }, 'parent_graph'),

  graphNode('planning', 'planning', 'Parent 映射分类上下文', { x: 235, y: 65 }, 'planning_subgraph'),
  graphNode('load_question_history', 'load_question_history', '读取最多 30 条排除题干', { x: 235, y: 175 }, 'planning_subgraph'),
  graphNode('retrieve_question_signals', 'retrieve_question_signals', '检索当前分类出题信号', { x: 235, y: 285 }, 'planning_subgraph'),
  graphNode('plan_round', 'plan_round', '进入 Planner Tool Loop', { x: 235, y: 395 }, 'planning_subgraph'),

  graphNode('call_model', 'call_model', '模型决定调用 Tool 或输出题目', { x: 185, y: 55 }, 'tool_loop'),
  graphNode('check_round_budget', 'check_round_budget', '检查轮次与失败预算', { x: 185, y: 165 }, 'tool_loop'),
  graphNode('execute_tools', 'execute_tools', '加载 Skill 或检索资料', { x: 185, y: 275 }, 'tool_loop'),
  graphNode('append_tool_outputs', 'append_tool_outputs', '把安全结果回填模型', { x: 185, y: 385 }, 'tool_loop'),
  graphNode('planner_finish', 'finish', '验证结构化五题输出', { x: 185, y: 520 }, 'tool_loop', 'terminal'),

  graphNode('collect_section', 'collect_section', '收集分类题卷，必要时继续规划', { x: 295, y: 1725 }, 'parent_graph'),
  graphNode('persist_questions', 'persist_questions', '幂等保存正式题目', { x: 295, y: 1845 }, 'parent_graph'),
  graphNode('answer_questions', 'answer_questions', 'Interrupt 等待用户答案', { x: 295, y: 1965 }, 'parent_graph', 'interrupt'),
  graphNode('verify', 'verify', 'TypeScript 确定性判分', { x: 295, y: 2085 }, 'parent_graph'),
  graphNode('persist_memory', 'persist_memory', '保存本轮作答事实', { x: 295, y: 2205 }, 'parent_graph'),
  graphNode('wait_next_round', 'wait_next_round', 'Interrupt 等待继续决定', { x: 295, y: 2325 }, 'parent_graph', 'interrupt'),
  graphNode('replan', 'replan', '准备下一轮 Planner 输入', { x: 155, y: 2450 }, 'parent_graph'),
  graphNode('finish', 'finish', '达到最大轮数后结束', { x: 435, y: 2450 }, 'parent_graph', 'terminal'),
  graphNode('failed', 'END: failed', '任意受控错误的安全终态', { x: 295, y: 2585 }, 'parent_graph', 'error'),
]

const EDGE_DEFAULTS = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed },
} as const

function edge(
  id: string,
  source: GraphNodeId,
  target: GraphNodeId,
  options: Pick<Edge, 'label' | 'className'> = {},
): Edge {
  return { id, source, target, ...EDGE_DEFAULTS, ...options }
}

const GRAPH_EDGES: Edge[] = [
  edge('initialize-load-memory', 'initialize', 'load_memory'),
  edge('load-memory-load-jd', 'load_memory', 'load_jd_context'),
  edge('load-jd-select-categories', 'load_jd_context', 'select_categories'),
  edge('select-categories-planning', 'select_categories', 'planning'),
  edge('planning-history', 'planning', 'load_question_history'),
  edge('history-signals', 'load_question_history', 'retrieve_question_signals'),
  edge('signals-plan-round', 'retrieve_question_signals', 'plan_round'),
  edge('plan-round-call-model', 'plan_round', 'call_model'),
  edge('call-model-budget', 'call_model', 'check_round_budget'),
  edge('budget-execute-tools', 'check_round_budget', 'execute_tools', { label: 'Tool Call' }),
  edge('execute-tools-append', 'execute_tools', 'append_tool_outputs'),
  edge('append-call-model', 'append_tool_outputs', 'call_model', {
    label: '下一 Tool Round',
    className: 'quiz-flow-edge-loop',
  }),
  edge('budget-planner-finish', 'check_round_budget', 'planner_finish', { label: 'Final Output' }),
  edge('planner-finish-collect', 'planner_finish', 'collect_section'),
  edge('collect-next-category', 'collect_section', 'planning', {
    label: '下一分类',
    className: 'quiz-flow-edge-loop',
  }),
  edge('collect-persist', 'collect_section', 'persist_questions', { label: '分类完成' }),
  edge('persist-answer', 'persist_questions', 'answer_questions'),
  edge('answer-verify', 'answer_questions', 'verify'),
  edge('verify-memory', 'verify', 'persist_memory'),
  edge('memory-wait', 'persist_memory', 'wait_next_round'),
  edge('wait-replan', 'wait_next_round', 'replan', { label: '继续' }),
  edge('replan-planning', 'replan', 'planning', {
    label: '下一轮',
    className: 'quiz-flow-edge-loop',
  }),
  edge('wait-finish', 'wait_next_round', 'finish', { label: '结束' }),
]

export function progressPhaseToNodeId(phase: string): GraphNodeId | undefined {
  return PHASE_NODE_MAP[phase]
}

function stableViewNode(view: InterviewQuizView | undefined): GraphNodeId | undefined {
  if (!view)
    return undefined
  if (view.status === 'needs_answers')
    return 'answer_questions'
  if (view.status === 'round_result')
    return 'wait_next_round'
  if (view.status === 'completed')
    return 'finish'
  if (view.status === 'failed')
    return 'failed'
  return undefined
}

function QuizNode({ data, isConnectable }: NodeProps<QuizFlowNode>) {
  return (
    <div className={`quiz-flow-node quiz-flow-node-${data.tone ?? 'default'}`}>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
      />
      <strong>{data.label}</strong>
      <span>{data.detail}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
      />
    </div>
  )
}

const NODE_TYPES = { quizNode: QuizNode }

const ACTIVITY_SCOPE_LABEL: Record<QuizActivityEvent['scope'], string> = {
  parent: 'PARENT',
  planning: 'PLAN',
  tool_loop: 'LOOP',
  tool: 'TOOL',
}

function activityTime(timestamp: string) {
  const time = new Date(timestamp)
  return Number.isNaN(time.getTime())
    ? '--:--:--'
    : time.toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
}

function RuntimeActivityLog({
  activities,
}: {
  activities: readonly QuizActivityEvent[]
}) {
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight
  }, [activities.length])

  return (
    <details className="quiz-runtime-log" open>
      <summary>
        <span>运行日志</span>
        <small>{`${activities.length} EVENTS`}</small>
      </summary>
      <ol
        ref={listRef}
        className="quiz-runtime-log-list"
        aria-live="polite"
        aria-label="Graph 运行日志"
      >
        {activities.length === 0
          ? (
              <li className="quiz-runtime-log-empty">
                启动答题后，这里会按顺序显示 Node、Tool 和错误事件。
              </li>
            )
          : activities.map(activity => (
              <li className={`is-${activity.level}`} key={activity.id}>
                <time dateTime={activity.timestamp}>{activityTime(activity.timestamp)}</time>
                <span className="quiz-runtime-log-scope">
                  {ACTIVITY_SCOPE_LABEL[activity.scope]}
                </span>
                <span className="quiz-runtime-log-message">
                  {activity.label}
                  {activity.errorCode ? ` · ${activity.errorCode}` : ''}
                </span>
              </li>
            ))}
      </ol>
    </details>
  )
}

function graphNodeCenter(nodeId: GraphNodeId) {
  let node = BASE_NODES.find(candidate => candidate.id === nodeId)
  let x = 0
  let y = 0

  while (node) {
    x += node.position.x
    y += node.position.y
    node = node.parentId
      ? BASE_NODES.find(candidate => candidate.id === node?.parentId)
      : undefined
  }

  return { x: x + 95, y: y + 34 }
}

function GraphCanvas({ activeNodeId }: { activeNodeId?: GraphNodeId }) {
  const { setCenter } = useReactFlow()
  const nodes = useMemo(() => BASE_NODES.map((node) => {
    const active = node.id === activeNodeId
    const activeScope = node.id === 'planning_subgraph'
      ? Boolean(activeNodeId && PLANNING_NODE_IDS.has(activeNodeId))
      : node.id === 'tool_loop'
        ? Boolean(activeNodeId && TOOL_LOOP_NODE_IDS.has(activeNodeId))
        : false

    return {
      ...node,
      className: [node.className, active ? 'is-active' : '', activeScope ? 'has-active-node' : '']
        .filter(Boolean)
        .join(' '),
      ariaLabel: active && node.type === 'quizNode'
        ? `当前节点：${node.data.label}`
        : undefined,
    }
  }), [activeNodeId])

  useEffect(() => {
    if (!activeNodeId)
      return

    // 等 React Flow 把最新 Node class 和测量结果写入 Store 后再移动视口。
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches
      const center = graphNodeCenter(activeNodeId)

      void setCenter(
        center.x,
        center.y,
        {
          zoom: 0.82,
          duration: reduceMotion ? 0 : 320,
        },
      )
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeNodeId, setCenter])

  return (
    <ReactFlow
      nodes={nodes}
      edges={GRAPH_EDGES}
      nodeTypes={NODE_TYPES}
      defaultViewport={{ x: 0, y: 20, zoom: 0.65 }}
      minZoom={0.12}
      maxZoom={1.4}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnDrag
      zoomOnDoubleClick
      aria-label="Interview Quiz Graph 节点画布"
      proOptions={{ hideAttribution: true }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1}
        color="#cbd5ce"
      />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  )
}

export function InterviewQuizGraph({
  view,
  progress,
  activities,
  loading,
}: InterviewQuizGraphProps) {
  const activeNodeId = useMemo(
    () => progressPhaseToNodeId(progress?.phase ?? '') ?? stableViewNode(view),
    [progress?.phase, view],
  )
  const currentLabel = progress?.label
    ?? (view?.status === 'needs_answers'
      ? '等待提交本轮答案'
      : view?.status === 'round_result'
        ? '本轮完成，等待下一轮决定'
        : view?.status === 'completed'
          ? '本次训练已经完成'
          : view?.status === 'failed'
            ? 'Graph 已进入失败终态'
            : '尚未启动 Graph')

  return (
    <aside className="quiz-graph-panel" aria-label="Interview Quiz Graph 运行流程">
      <header className="quiz-graph-header">
        <div>
          <p className="graph-kicker">LangGraph runtime</p>
          <h2>执行流程</h2>
        </div>
        <span className={`graph-run-state${loading ? ' is-running' : ''}`}>
          {loading ? '运行中' : '当前状态'}
        </span>
      </header>

      <div className="graph-current" aria-live="polite">
        <strong>{currentLabel}</strong>
        <span>
          {progress?.round ? `第 ${progress.round} 轮` : '当前会话'}
          {progress?.categoryIndex && progress.categoryCount
            ? `，分类 ${progress.categoryIndex}/${progress.categoryCount}`
            : ''}
          {progress?.toolRound !== undefined
            ? `，Tool Round ${progress.toolRound}`
            : ''}
        </span>
      </div>

      <div className="quiz-flow-canvas">
        <ReactFlowProvider>
          <GraphCanvas activeNodeId={activeNodeId} />
        </ReactFlowProvider>
      </div>

      <RuntimeActivityLog activities={activities} />
    </aside>
  )
}
