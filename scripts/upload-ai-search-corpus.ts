import type { CloudflareAiSearchItem } from '../src/knowledge/cloudflare-ai-search-uploader'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import {
  CloudflareAiSearchItemStatus,
  CloudflareAiSearchMetadataType,
  createCloudflareAiSearchUploaderFromEnv,
} from '../src/knowledge/cloudflare-ai-search-uploader'

enum CorpusGroup {
  Official = 'official',
  JdMarket = 'jd_market',
  InterviewBank = 'interview_bank',
}

interface CorpusEntry {
  group: CorpusGroup
  sourcePath: string
  key: string
  metadata: {
    evidence_role: 'answer_evidence' | 'question_signal'
    source_type: 'official' | 'jd' | 'interview_bank'
  }
}

const officialDirectory = resolve(import.meta.dir, '../knowledge/official')
const officialKeys: Record<string, string> = {
  'cloudflare-ai-search.md': 'official/cloudflare/cloudflare-ai-search.md',
  'langgraph-graph-api.md': 'official/langgraph/langgraph-graph-api.md',
  'langgraph-interrupt-persistence.md': 'official/langgraph/langgraph-interrupt-persistence.md',
  'openai-conversation-state.md': 'official/openai/openai-conversation-state.md',
  'openai-function-calling.md': 'official/openai/openai-function-calling.md',
  'openai-structured-outputs.md': 'official/openai/openai-structured-outputs.md',
}

/**
 * 只上传整理后的正文。README 和候选来源表不是检索语料；Kamacoder 的
 * candidates 与完整 question index 重叠，因此本批只保留后者。
 */
const interviewBankKeys: Record<string, string> = {
  'xiaolin-agent-interview-reference.md': 'question-signal/interview-bank/xiaolin/xiaolin-agent-interview-reference.md',
  'kamacoder-llm-interview-question-index.md': 'question-signal/interview-bank/kamacoder/kamacoder-llm-interview-question-index.md',
  'github-agent-llm-interview-question-index.md': 'question-signal/interview-bank/github/github-agent-llm-interview-question-index.md',
  'ai-agent-production-security-experience-notes.md': 'question-signal/interview-bank/community-experience/ai-agent-production-security-experience-notes.md',
}

const expectedCounts: Record<CorpusGroup, number> = {
  [CorpusGroup.Official]: 6,
  [CorpusGroup.JdMarket]: 96,
  [CorpusGroup.InterviewBank]: 4,
}

function optionValue(name: string) {
  const args = process.argv.slice(2)
  const inline = args.find(arg => arg.startsWith(`${name}=`))
  if (inline)
    return inline.slice(name.length + 1).trim()

  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value && !value.startsWith('--') ? value.trim() : undefined
}

function requiredDirectory(option: string, envName: string) {
  const value = optionValue(option) || process.env[envName]?.trim()
  if (!value) {
    throw new Error(
      `${option} or ${envName} is required for the local corpus source.`,
    )
  }
  return resolve(value)
}

async function markdownFilenames(directory: string) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
}

async function buildCorpusEntries(input: {
  jdDirectory: string
  interviewBankDirectory: string
}): Promise<CorpusEntry[]> {
  const entries: CorpusEntry[] = Object.entries(officialKeys).map(
    ([filename, key]) => ({
      group: CorpusGroup.Official,
      sourcePath: join(officialDirectory, filename),
      key,
      metadata: {
        evidence_role: 'answer_evidence',
        source_type: 'official',
      },
    }),
  )

  for (const filename of await markdownFilenames(input.jdDirectory)) {
    entries.push({
      group: CorpusGroup.JdMarket,
      sourcePath: join(input.jdDirectory, filename),
      key: `question-signal/jd-market/${filename}`,
      metadata: {
        evidence_role: 'question_signal',
        source_type: 'jd',
      },
    })
  }

  for (const [filename, key] of Object.entries(interviewBankKeys)) {
    entries.push({
      group: CorpusGroup.InterviewBank,
      sourcePath: join(input.interviewBankDirectory, filename),
      key,
      metadata: {
        evidence_role: 'question_signal',
        source_type: 'interview_bank',
      },
    })
  }

  return entries
}

async function validateCorpus(entries: readonly CorpusEntry[]) {
  const keys = new Set<string>()
  const counts = new Map<CorpusGroup, number>()
  const localPathPattern = /(?<![a-z])(?:file:\/\/|[a-z]:[\\/])/i

  for (const entry of entries) {
    counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1)
    if (keys.has(entry.key))
      throw new Error(`Duplicate AI Search key: ${entry.key}`)
    keys.add(entry.key)

    if (entry.key.length > 128)
      throw new Error(`AI Search key exceeds 128 characters: ${entry.key}`)

    const file = Bun.file(entry.sourcePath)
    if (!await file.exists())
      throw new Error(`Corpus file is missing: ${basename(entry.sourcePath)}`)
    if (file.size > 4 * 1024 * 1024)
      throw new Error(`Corpus file exceeds the 4 MB limit: ${entry.key}`)

    const content = await file.text()
    if (localPathPattern.test(content)) {
      throw new Error(`Corpus contains a local absolute path: ${entry.key}`)
    }
  }

  for (const [group, expected] of Object.entries(expectedCounts)) {
    const actual = counts.get(group as CorpusGroup) ?? 0
    if (actual !== expected) {
      throw new Error(
        `Unexpected ${group} count: expected ${expected}, received ${actual}.`,
      )
    }
  }
}

function metadataMatches(item: CloudflareAiSearchItem, entry: CorpusEntry) {
  return item.metadata.evidence_role === entry.metadata.evidence_role
    && item.metadata.source_type === entry.metadata.source_type
}

function summarize(
  entries: readonly CorpusEntry[],
  items: readonly CloudflareAiSearchItem[],
) {
  const byKey = new Map(items.map(item => [item.key, item]))
  const summary = new Map<CorpusGroup, {
    expected: number
    completed: number
    pending: number
    failed: number
    missing: number
    metadataMismatch: number
  }>()

  for (const group of Object.values(CorpusGroup)) {
    summary.set(group, {
      expected: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      missing: 0,
      metadataMismatch: 0,
    })
  }

  for (const entry of entries) {
    const row = summary.get(entry.group)
    if (!row)
      continue
    row.expected += 1

    const item = byKey.get(entry.key)
    if (!item) {
      row.missing += 1
      continue
    }
    // Cloudflare 在 queued/running 阶段可能暂时不返回新 metadata；只有
    // completed 后仍不匹配才算真实错误，避免状态轮询误报。
    if (
      item.status === CloudflareAiSearchItemStatus.Completed
      && !metadataMatches(item, entry)
    ) {
      row.metadataMismatch += 1
    }

    if (item.status === CloudflareAiSearchItemStatus.Completed) {
      row.completed += 1
    }
    else if (
      item.status === CloudflareAiSearchItemStatus.Error
      || item.status === CloudflareAiSearchItemStatus.Skipped
    ) {
      row.failed += 1
    }
    else {
      row.pending += 1
    }
  }

  for (const [group, row] of summary)
    console.log(`${group}: ${JSON.stringify(row)}`)

  return [...summary.values()].every(row => (
    row.completed === row.expected
    && row.metadataMismatch === 0
    && row.failed === 0
    && row.missing === 0
  ))
}

const jdDirectory = requiredDirectory('--jd-dir', 'JD_MARKET_CORPUS_DIR')
const interviewBankDirectory = requiredDirectory(
  '--interview-bank-dir',
  'INTERVIEW_BANK_DIR',
)
const entries = await buildCorpusEntries({
  jdDirectory,
  interviewBankDirectory,
})
await validateCorpus(entries)

const configuredUploader = createCloudflareAiSearchUploaderFromEnv(process.env)
if (!configuredUploader) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_SEARCH_INSTANCE and CLOUDFLARE_API_TOKEN are required.',
  )
}
const uploader = configuredUploader

console.log(`Corpus validated: ${entries.length} documents.`)
if (process.argv.includes('--dry-run')) {
  for (const group of Object.values(CorpusGroup)) {
    console.log(`${group}: ${entries.filter(entry => entry.group === group).length}`)
  }
  process.exit(0)
}

if (process.argv.includes('--status')) {
  const complete = summarize(entries, await uploader.listAll())
  process.exit(complete ? 0 : 2)
}

if (!process.argv.includes('--apply')) {
  throw new Error('Refusing external writes without the explicit --apply flag.')
}

const schema = await uploader.ensureMetadataSchema([
  {
    fieldName: 'evidence_role',
    dataType: CloudflareAiSearchMetadataType.Text,
  },
  {
    fieldName: 'source_type',
    dataType: CloudflareAiSearchMetadataType.Text,
  },
])
console.log(`Metadata schema: ${schema.changed ? 'updated' : 'unchanged'}.`)

const existingItems = new Map(
  (await uploader.listAll()).map(item => [item.key, item]),
)
let uploaded = 0
let skipped = 0
for (const entry of entries) {
  const existing = existingItems.get(entry.key)
  const accepted = existing && [
    CloudflareAiSearchItemStatus.Queued,
    CloudflareAiSearchItemStatus.Running,
    CloudflareAiSearchItemStatus.Completed,
  ].includes(existing.status)
  const indexing = existing && [
    CloudflareAiSearchItemStatus.Queued,
    CloudflareAiSearchItemStatus.Running,
  ].includes(existing.status)

  if (
    !process.argv.includes('--force')
    && accepted
    && (indexing || metadataMatches(existing, entry))
  ) {
    skipped += 1
    continue
  }

  await uploader.upload({
    key: entry.key,
    file: Bun.file(entry.sourcePath),
    metadata: entry.metadata,
  })
  uploaded += 1
  if (uploaded % 10 === 0 || uploaded === entries.length)
    console.log(`Upload accepted: ${uploaded} documents.`)
}
console.log(`Upload phase finished: uploaded=${uploaded}, skipped=${skipped}.`)

if (process.argv.includes('--wait')) {
  const deadline = Date.now() + 15 * 60 * 1000
  while (true) {
    const complete = summarize(entries, await uploader.listAll())
    if (complete)
      break
    if (Date.now() >= deadline)
      throw new Error('AI Search indexing did not complete within 15 minutes.')
    await Bun.sleep(5000)
  }
}

if (process.argv.includes('--prune-legacy-official')) {
  const latestItems = await uploader.listAll()
  const latestByKey = new Map(latestItems.map(item => [item.key, item]))
  const newOfficialComplete = entries
    .filter(entry => entry.group === CorpusGroup.Official)
    .every((entry) => {
      const item = latestByKey.get(entry.key)
      return item?.status === CloudflareAiSearchItemStatus.Completed
        && metadataMatches(item, entry)
    })

  if (!newOfficialComplete) {
    throw new Error('Refusing to prune legacy official items before replacements complete.')
  }

  let deleted = 0
  for (const legacyKey of Object.keys(officialKeys)) {
    const legacyItem = latestByKey.get(legacyKey)
    if (!legacyItem)
      continue
    await uploader.deleteById(legacyItem.id)
    deleted += 1
  }
  console.log(`Legacy official items removed: ${deleted}.`)
}
