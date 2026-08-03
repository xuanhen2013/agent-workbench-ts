export const DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS = 30_000

export interface TimeoutSignal {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
}

/**
 * 把调用方取消和本次请求超时合并成一个 signal。
 * timedOut() 用来区分“用户/上层取消”和“远程服务等待超时”。
 */
export function createTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('timeoutMs must be greater than zero.')

  const controller = new AbortController()
  let timeoutReached = false
  let disposed = false

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason)
  }

  if (parentSignal?.aborted)
    abortFromParent()
  else
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  const timer = setTimeout(() => {
    timeoutReached = true
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      if (disposed)
        return
      disposed = true
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
  }
}

/**
 * fetch 通常会响应 AbortSignal，但测试替身或单独的 response.json() 未必会。
 * 这一层保证 signal 一旦取消，等待中的 Promise 也会立即结束。
 */
export function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
