/**
 * Interview Quiz Workflow 对外暴露的稳定错误码。
 *
 * 这里只集中“这个 Workflow 能失败成什么”以及对应的安全默认文案，不保存：
 * - OpenAI、Skill Loader、Retriever 等底层原始错误；
 * - HTTP status 和 Route 边界错误；
 *
 * Node 只选择稳定 code，不再重复手写 message。底层异常先转换成这里的
 * 稳定错误，再写入 Graph State，避免向外泄露原始异常。
 */
export enum InterviewQuizErrorCode {
  // Graph / Runtime
  RoundContextMissing = 'round_context_missing',
  InsufficientKnowledge = 'insufficient_knowledge',
  KnowledgeRetrievalFailed = 'knowledge_retrieval_failed',
  PlannerCallFailed = 'planner_call_failed',
  RoundPlanMissing = 'round_plan_missing',
  GradingInputMissing = 'grading_input_missing',
  RoundResultMissing = 'round_result_missing',
  InvalidNextRoundDecision = 'invalid_next_round_decision',
  ReplanResultMissing = 'replan_result_missing',

  // Planner / Skill
  SkillToolFailed = 'quiz_skill_tool_failed',
  KnowledgeToolFailed = 'quiz_knowledge_tool_failed',
  PlannerToolRoundLimit = 'quiz_planner_tool_round_limit',
  QuestionSignalSearchLimit = 'quiz_question_signal_search_limit',
  AnswerEvidenceSearchLimit = 'quiz_answer_evidence_search_limit',
  AnswerEvidenceMissing = 'quiz_answer_evidence_missing',
  SkillFinalOutputMissing = 'quiz_skill_final_output_missing',
  RequiredSkillMissing = 'quiz_required_skill_missing',
  PlannerJsonInvalid = 'planner_json_invalid',
  InvalidQuizRoundDraft = 'invalid_quiz_round_draft',

  // Planner domain validation
  SourceChunkRequired = 'source_chunk_required',
  DuplicateSourceChunkId = 'duplicate_source_chunk_id',
  UnknownSourceChunkId = 'unknown_source_chunk_id',
  DuplicateOptionId = 'duplicate_option_id',
  DuplicateCorrectOptionId = 'duplicate_correct_option_id',
  CorrectOptionNotFound = 'correct_option_not_found',
  InvalidSingleAnswerCount = 'invalid_single_answer_count',
  InvalidMultipleAnswerCount = 'invalid_multiple_answer_count',
  InvalidMultipleAllOptionsCorrect = 'invalid_multiple_all_options_correct',
  RepeatedQuestionStem = 'repeated_question_stem',
  DuplicateQuestionStem = 'duplicate_question_stem',

  // Answer submission validation
  InvalidSubmissionShape = 'invalid_submission_shape',
  ReviewIdMismatch = 'review_id_mismatch',
  DuplicateQuestionAnswer = 'duplicate_question_answer',
  UnknownQuestionId = 'unknown_question_id',
  DuplicateSelectedOption = 'duplicate_selected_option',
  UnknownSelectedOption = 'unknown_selected_option',
  InvalidSingleSelectionCount = 'invalid_single_selection_count',
  MissingQuestionAnswer = 'missing_question_answer',
}

/**
 * 每个稳定错误码的默认安全文案。
 *
 * `satisfies Record` 会在新增 ErrorCode 却忘记补 Message 时直接产生 TS 错误。
 */
export const InterviewQuizErrorMessages = {
  [InterviewQuizErrorCode.RoundContextMissing]: '当前轮次的规划参数不存在',
  [InterviewQuizErrorCode.InsufficientKnowledge]: '当前轮没有可用于证明答案的知识资料',
  [InterviewQuizErrorCode.KnowledgeRetrievalFailed]: '检索 Agent 面试资料失败',
  [InterviewQuizErrorCode.PlannerCallFailed]: '生成 Agent 面试题失败',
  [InterviewQuizErrorCode.RoundPlanMissing]: '当前题卷不存在',
  [InterviewQuizErrorCode.GradingInputMissing]: '判分所需的题卷或答案不存在',
  [InterviewQuizErrorCode.RoundResultMissing]: '当前轮次结果不存在',
  [InterviewQuizErrorCode.InvalidNextRoundDecision]: '下一轮操作与当前结果不匹配',
  [InterviewQuizErrorCode.ReplanResultMissing]: 'RePlan 缺少上一轮结果',

  [InterviewQuizErrorCode.SkillToolFailed]: 'Skill Tool 执行失败。',
  [InterviewQuizErrorCode.KnowledgeToolFailed]: '知识检索 Tool 执行失败。',
  [InterviewQuizErrorCode.PlannerToolRoundLimit]: 'Planner Tool 调用超过允许轮次。',
  [InterviewQuizErrorCode.QuestionSignalSearchLimit]: '常考题方向搜索超过允许次数。',
  [InterviewQuizErrorCode.AnswerEvidenceSearchLimit]: '答案证据搜索超过允许次数。',
  [InterviewQuizErrorCode.AnswerEvidenceMissing]: '当前轮没有检索到可用于证明答案的知识资料。',
  [InterviewQuizErrorCode.SkillFinalOutputMissing]: '模型没有返回最终题目。',
  [InterviewQuizErrorCode.RequiredSkillMissing]: '生成题目前必须加载所需的出题和检索 Skill。',
  [InterviewQuizErrorCode.PlannerJsonInvalid]: '模型没有返回合法 JSON',
  [InterviewQuizErrorCode.InvalidQuizRoundDraft]: '模型返回的数据不符合题目结构',

  [InterviewQuizErrorCode.SourceChunkRequired]: '启用知识检索时，每道题都必须引用答案证据。',
  [InterviewQuizErrorCode.DuplicateSourceChunkId]: '同一道题不能重复引用同一个知识片段。',
  [InterviewQuizErrorCode.UnknownSourceChunkId]: '题目引用了本轮不存在的答案证据。',
  [InterviewQuizErrorCode.DuplicateOptionId]: '同一道题中存在重复选项 ID',
  [InterviewQuizErrorCode.DuplicateCorrectOptionId]: '同一道题中存在重复的正确答案 ID',
  [InterviewQuizErrorCode.CorrectOptionNotFound]: '正确答案引用了不存在的选项',
  [InterviewQuizErrorCode.InvalidSingleAnswerCount]: '单选题必须且只能有一个正确答案',
  [InterviewQuizErrorCode.InvalidMultipleAnswerCount]: '多选题必须至少有两个正确答案',
  [InterviewQuizErrorCode.InvalidMultipleAllOptionsCorrect]: '多选题不能把全部选项都设为正确答案',
  [InterviewQuizErrorCode.RepeatedQuestionStem]: '题目与历史轮次重复',
  [InterviewQuizErrorCode.DuplicateQuestionStem]: '本轮存在重复题干',

  [InterviewQuizErrorCode.InvalidSubmissionShape]: '提交的题卷格式不合法',
  [InterviewQuizErrorCode.ReviewIdMismatch]: '提交内容不属于当前题卷',
  [InterviewQuizErrorCode.DuplicateQuestionAnswer]: '同一道题被重复提交',
  [InterviewQuizErrorCode.UnknownQuestionId]: '提交中包含未知题目',
  [InterviewQuizErrorCode.DuplicateSelectedOption]: '同一选项被重复提交',
  [InterviewQuizErrorCode.UnknownSelectedOption]: '提交中包含未知选项',
  [InterviewQuizErrorCode.InvalidSingleSelectionCount]: '单选题必须选择一个选项',
  [InterviewQuizErrorCode.MissingQuestionAnswer]: '必须回答本轮全部题目',
} satisfies Record<InterviewQuizErrorCode, string>

export interface InterviewQuizError {
  code: InterviewQuizErrorCode
  message: string
}

/** 由错误码创建可以安全写入 State 或返回给调用方的稳定错误。 */
export function createInterviewQuizError(
  code: InterviewQuizErrorCode,
): InterviewQuizError {
  return {
    code,
    message: InterviewQuizErrorMessages[code],
  }
}
