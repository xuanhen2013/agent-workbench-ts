import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadInterviewBankDocuments } from '@/agent/interview-quiz/corpus/interview-bank-loader'
import {
  KnowledgeEvidenceRole,
  KnowledgeSourceType,
} from '@/knowledge/contracts'

describe('interview-bank Loader', () => {
  test('只读取 Markdown、排序稳定，并固定为 question_signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-bank-'))
    try {
      await Promise.all([
        writeFile(join(directory, 'README.md'), '# ignore', 'utf8'),
        writeFile(join(directory, 'b.md'), '# B\nTool Calling', 'utf8'),
        writeFile(join(directory, 'a.md'), '# A\nLangGraph', 'utf8'),
        writeFile(join(directory, 'notes.txt'), 'ignore', 'utf8'),
      ])

      const documents = await loadInterviewBankDocuments(directory)
      expect(documents.map(document => document.title)).toEqual(['A', 'B'])
      expect(documents.every(document => (
        document.sourceType === KnowledgeSourceType.InterviewBank
        && document.evidenceRole === KnowledgeEvidenceRole.QuestionSignal
      ))).toBe(true)
      expect(documents.map(document => document.sourceUri)).toEqual([
        'local:interview-bank/a.md',
        'local:interview-bank/b.md',
      ])
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('移除本机绝对路径，并且相同内容得到稳定 documentId', async () => {
    const createDirectory = () => mkdtemp(join(tmpdir(), 'agent-bank-'))
    const first = await createDirectory()
    const second = await createDirectory()
    try {
      const content = '# Notes\nSee [local](D:\\private\\secret.md) and file:///C:/secret.md.'
      await writeFile(join(first, 'notes.md'), content, 'utf8')
      await writeFile(join(second, 'notes.md'), content, 'utf8')

      const [left] = await loadInterviewBankDocuments(first)
      const [right] = await loadInterviewBankDocuments(second)
      expect(left?.documentId).toBe(right?.documentId)
      expect(left?.content).not.toContain('D:\\private')
      expect(left?.content).not.toContain('file:///C:/secret')
      expect(await readFile(join(first, 'notes.md'), 'utf8')).toBe(content)
    }
    finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ])
    }
  })
})
