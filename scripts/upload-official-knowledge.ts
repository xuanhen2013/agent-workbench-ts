import { readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import {
  CloudflareAiSearchItemStatus,
  createCloudflareAiSearchUploaderFromEnv,
} from '../src/knowledge/cloudflare-ai-search-uploader'

const officialDirectory = resolve(import.meta.dir, '../knowledge/official')
const filenames = (await readdir(officialDirectory))
  .filter(filename => filename.endsWith('.md'))
  .sort()

const configuredUploader = createCloudflareAiSearchUploaderFromEnv(process.env)
if (!configuredUploader) {
  throw new Error(
    'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_SEARCH_INSTANCE and CLOUDFLARE_API_TOKEN are required.',
  )
}
const uploader = configuredUploader

async function showStatus() {
  let completed = 0
  for (const filename of filenames) {
    const items = await uploader.listByKey(filename)
    const item = items[0]

    if (!item) {
      console.log(`${filename}: missing`)
      continue
    }

    if (item.status === CloudflareAiSearchItemStatus.Completed)
      completed += 1

    console.log(
      `${filename}: ${item.status}, chunks=${item.chunksCount}`,
    )
  }

  console.log(`completed=${completed}/${filenames.length}`)
}
if (process.argv.includes('--status')) {
  await showStatus()
}
else {
  const force = process.argv.includes('--force')

  for (const filename of filenames) {
    if (!force) {
      const existing = (await uploader.listByKey(filename))[0]
      const alreadyAccepted = existing && [
        CloudflareAiSearchItemStatus.Queued,
        CloudflareAiSearchItemStatus.Running,
        CloudflareAiSearchItemStatus.Completed,
      ].includes(existing.status)

      if (alreadyAccepted) {
        console.log(`${filename}: skipped, status=${existing.status}`)
        continue
      }
    }

    const filePath = resolve(officialDirectory, filename)
    const item = await uploader.upload({
      filename: basename(filePath),
      file: Bun.file(filePath),
    })
    console.log(`${filename}: uploaded, status=${item.status}`)
  }

  console.log('Upload accepted. Indexing is asynchronous; rerun with --status.')
}
