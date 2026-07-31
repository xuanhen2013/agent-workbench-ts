import type {
  LoadedSkill,
  LoadedSkillResource,
  SkillCatalogEntry,
  SkillMetadata,
  SkillName,
} from './contracts'
import { readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { SkillFrontmatterSchema } from './contracts'
import {
  raiseSkillLoaderError,
  SkillLoaderErrorCode,
} from './errors'

export {
  createSkillLoaderError,
  SkillLoaderError,
  SkillLoaderErrorCode,
} from './errors'

function loaderError(code: SkillLoaderErrorCode): never {
  return raiseSkillLoaderError(code)
}

function normalizeRoot(root: URL): URL {
  if (root.protocol !== 'file:') {
    return loaderError(
      SkillLoaderErrorCode.InvalidRoot,
    )
  }

  return new URL(root.href.endsWith('/') ? root.href : `${root.href}/`)
}

async function readManifest(root: URL): Promise<string> {
  try {
    return await readFile(new URL('SKILL.md', root), 'utf8')
  }
  catch {
    return loaderError(
      SkillLoaderErrorCode.ManifestReadFailed,
    )
  }
}

export function parseSkillDocument(
  raw: string,
  expectedDirectoryName: string,
): {
  metadata: SkillMetadata
  instructions: string
} {
  const match = raw.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  )

  if (!match) {
    return loaderError(
      SkillLoaderErrorCode.InvalidDocument,
    )
  }

  let candidate: unknown
  try {
    candidate = parse(match[1]!)
  }
  catch {
    return loaderError(
      SkillLoaderErrorCode.InvalidDocument,
    )
  }

  const parsed = SkillFrontmatterSchema.safeParse(candidate)
  if (!parsed.success) {
    return loaderError(
      SkillLoaderErrorCode.InvalidDocument,
    )
  }

  if (parsed.data.name !== expectedDirectoryName) {
    return loaderError(
      SkillLoaderErrorCode.NameMismatch,
    )
  }

  const instructions = match[2]!.trim()
  if (!instructions) {
    return loaderError(
      SkillLoaderErrorCode.InvalidDocument,
    )
  }

  return {
    metadata: {
      name: parsed.data.name,
      description: parsed.data.description,
    },
    instructions,
  }
}

export async function loadSkillCatalog(
  roots: readonly URL[],
): Promise<SkillCatalogEntry[]> {
  const catalog = await Promise.all(roots.map(async (candidateRoot) => {
    const root = normalizeRoot(candidateRoot)
    const expectedDirectoryName = basename(fileURLToPath(root))
    const document = parseSkillDocument(
      await readManifest(root),
      expectedDirectoryName,
    )

    return {
      ...document.metadata,
      root,
    }
  }))

  const names = new Set<SkillName>()
  for (const entry of catalog) {
    if (names.has(entry.name)) {
      return loaderError(
        SkillLoaderErrorCode.DuplicateName,
      )
    }
    names.add(entry.name)
  }

  return catalog
}

export async function loadSkill(
  entry: SkillCatalogEntry,
): Promise<LoadedSkill> {
  const root = normalizeRoot(entry.root)
  const document = parseSkillDocument(
    await readManifest(root),
    basename(fileURLToPath(root)),
  )

  if (document.metadata.name !== entry.name) {
    return loaderError(
      SkillLoaderErrorCode.NameMismatch,
    )
  }

  return {
    ...document.metadata,
    instructions: document.instructions,
  }
}

function validateResourcePath(resourcePath: string): string {
  const normalized = resourcePath.trim()
  const segments = normalized.split('/')

  if (
    normalized.includes('\\')
    || !normalized.startsWith('references/')
    || !normalized.toLowerCase().endsWith('.md')
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    return loaderError(
      SkillLoaderErrorCode.InvalidResourcePath,
    )
  }

  return normalized
}

export async function readSkillResource(
  entry: SkillCatalogEntry,
  resourcePath: string,
): Promise<LoadedSkillResource> {
  const normalizedPath = validateResourcePath(resourcePath)
  const root = normalizeRoot(entry.root)
  const referencesRootUrl = new URL('references/', root)
  const targetUrl = new URL(normalizedPath, root)

  if (!targetUrl.href.startsWith(referencesRootUrl.href)) {
    return loaderError(
      SkillLoaderErrorCode.InvalidResourcePath,
    )
  }

  let referencesRoot: string
  let target: string
  try {
    [referencesRoot, target] = await Promise.all([
      realpath(fileURLToPath(referencesRootUrl)),
      realpath(fileURLToPath(targetUrl)),
    ])
  }
  catch {
    return loaderError(
      SkillLoaderErrorCode.ResourceReadFailed,
    )
  }

  const relativePath = relative(referencesRoot, target)
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || !target.toLowerCase().endsWith('.md')
  ) {
    return loaderError(
      SkillLoaderErrorCode.InvalidResourcePath,
    )
  }

  let content: string
  try {
    content = (await readFile(target, 'utf8')).trim()
  }
  catch {
    return loaderError(
      SkillLoaderErrorCode.ResourceReadFailed,
    )
  }

  if (!content) {
    return loaderError(
      SkillLoaderErrorCode.ResourceReadFailed,
    )
  }

  return {
    skillName: entry.name,
    resourcePath: normalizedPath,
    content,
  }
}

export function findSkill(
  catalog: readonly SkillCatalogEntry[],
  name: SkillName,
): SkillCatalogEntry | undefined {
  return catalog.find(entry => entry.name === name)
}
