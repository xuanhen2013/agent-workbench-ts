/**
 * 有优先级的显式错误映射规则。
 *
 * 这不是“猜测任意异常”的万能捕获器：每个边界必须明确声明匹配条件和
 * 安全结果，最后由调用方提供 fallback。
 */
export interface ErrorMappingRule<T> {
  matches: (error: unknown) => boolean
  map: (error: unknown) => T
}

export function mapError<T>(
  error: unknown,
  rules: readonly ErrorMappingRule<T>[],
  fallback: (error: unknown) => T,
): T {
  for (const rule of rules) {
    if (rule.matches(error))
      return rule.map(error)
  }

  return fallback(error)
}
