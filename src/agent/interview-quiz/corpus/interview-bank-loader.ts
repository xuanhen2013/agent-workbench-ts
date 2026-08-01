import type { SourceDocument } from '@/knowledge/contracts'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

/**
 * 读取题库目录，但不给题库“答案证据”权限。
 *
 * Loader 是信任边界：sourceType/evidenceRole 由服务端固定赋值，
 * 不能由 Markdown 自己通过 frontmatter 声明。
 */
export async function loadInterviewBankDocuments(
  directory: string,
): Promise<SourceDocument[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const filenames = entries
    .filter(entry => (
      entry.isFile()
      && entry.name.toLowerCase().endsWith('.md')
      && entry.name.toLowerCase() !== 'readme.md'
    ))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  return await Promise.all(filenames.map(async (filename) => {
    const raw = await readFile(join(directory, filename), 'utf8')
    const content = removeLocalPathTargets(raw).trim()
    const relativePath = filename.replaceAll('\\', '/')
    const contentHash = createHash('sha256')
      .update(content)
      .digest('hex')
      .slice(0, 16)
    const markdownTitle = content
      .split(/\r?\n/)
      .find(line => line.startsWith('# '))
      ?.slice(2)
      .trim()

    return {
      documentId: `interview-bank:${relativePath}:${contentHash}`,
      sourceType: KnowledgeSourceType.InterviewBank,
      evidenceRole: KnowledgeEvidenceRole.QuestionSignal,
      ownerId: null,
      title: markdownTitle || basename(filename, '.md'),
      sourceUri: `local:interview-bank/${relativePath}`,
      content,
    }
  }))
}

/** 防止外部题库把开发者本机绝对路径带入 Prompt 或 HTTP Trace。 */
function removeLocalPathTargets(content: string) {
  return content
    .replace(
      /\]\((?:file:\/\/|[a-z]:[\\/])[^)]*\)/gi,
      ']([local path omitted])',
    )
    .replace(
      /(?:file:\/\/|[a-z]:[\\/])[^\s`"'<>)]*/gi,
      '[local path omitted]',
    )
}
