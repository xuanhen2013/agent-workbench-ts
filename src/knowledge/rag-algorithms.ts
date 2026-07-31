import type { SourceDocument } from './contracts'
import { createHash } from 'node:crypto'

const MAX_CHUNK_CHARS = 1200
const EMBEDDING_DIMENSIONS = 128

/**
 * 这是 RAG 示例的“机械算法区”，初学阶段可以跳过整个文件。
 *
 * 这里没有新的 Agent 架构概念，只为主流程提供四个确定性函数：
 *
 * - splitDocumentIntoParts：Markdown → 小段文本；
 * - createStableChunkId：相同输入得到相同 ID；
 * - createFakeEmbedding：文本 → 测试向量；
 * - cosineSimilarity：比较两个向量。
 *
 * 生产环境通常会用成熟的文档解析器、Embedding Provider 和向量库
 * 替换这些实现，不要求面试时复述下面的算法细节。
 */

export interface DocumentPart {
  heading: string
  text: string
}

/** 先按一至三级 Markdown 标题分段，再处理超过 1200 字符的内容。 */
export function splitDocumentIntoParts(
  document: SourceDocument,
): DocumentPart[] {
  const sections: DocumentPart[] = []
  let heading = document.title
  let bodyLines: string[] = []

  const flush = () => {
    const text = bodyLines.join('\n').trim()
    if (text)
      sections.push({ heading, text })
    bodyLines = []
  }

  for (const line of document.content.split(/\r?\n/)) {
    const parsedHeading = parseMarkdownHeading(line)
    if (parsedHeading) {
      flush()
      heading = parsedHeading
      continue
    }
    bodyLines.push(line)
  }
  flush()

  const normalizedSections = sections.length > 0
    ? sections
    : [{ heading: document.title, text: normalizeText(document.content) }]

  return normalizedSections.flatMap(section => (
    splitLongText(section.text).map(text => ({
      heading: section.heading,
      text,
    }))
  ))
}

/** 不使用随机数，保证同一份文档重复导入时不会产生重复 Chunk。 */
export function createStableChunkId(
  documentId: string,
  ordinal: number,
  text: string,
) {
  return createHash('sha256')
    .update(`${documentId}:${ordinal}:${text}`)
    .digest('hex')
}

function parseMarkdownHeading(line: string): string | undefined {
  const trimmed = line.trim()
  let markerLength = 0

  while (trimmed[markerLength] === '#')
    markerLength += 1

  if (markerLength < 1 || markerLength > 3 || trimmed[markerLength] !== ' ')
    return undefined

  return trimmed.slice(markerLength + 1).trim() || undefined
}

function splitLongText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(normalizeText)
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    if (current)
      chunks.push(current)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush()
      for (let start = 0; start < paragraph.length; start += MAX_CHUNK_CHARS)
        chunks.push(paragraph.slice(start, start + MAX_CHUNK_CHARS))
      continue
    }

    const candidate = current ? `${current} ${paragraph}` : paragraph
    if (candidate.length <= MAX_CHUNK_CHARS) {
      current = candidate
    }
    else {
      flush()
      current = paragraph
    }
  }
  flush()

  return chunks
}

function normalizeText(text: string) {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * 这不是真实语义 Embedding。
 * 它把字符和相邻双字符 hash 到 128 个数字桶，只服务于离线测试。
 */
export function createFakeEmbedding(text: string): number[] {
  const normalized = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  const characters = Array.from(normalized)
  const features = [
    ...characters.map(character => `u:${character}`),
    ...characters.slice(0, -1).map((character, index) => (
      `b:${character}${characters[index + 1]}`
    )),
  ]
  const vector = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0)

  for (const feature of features) {
    const bucket = hashFeature(feature) % EMBEDDING_DIMENSIONS
    vector[bucket] = (vector[bucket] ?? 0) + 1
  }

  const length = Math.sqrt(vector.reduce((sum, value) => (
    sum + value * value
  ), 0))

  return length === 0 ? vector : vector.map(value => value / length)
}

function hashFeature(feature: string) {
  let hash = 2166136261
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 两个向量方向越接近，结果越接近 1。 */
export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0)
    return 0

  let dot = 0
  let leftLength = 0
  let rightLength = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftLength += leftValue * leftValue
    rightLength += rightValue * rightValue
  }

  if (leftLength === 0 || rightLength === 0)
    return 0

  return dot / Math.sqrt(leftLength * rightLength)
}
