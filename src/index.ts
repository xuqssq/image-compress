import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { resolveMaxQuality } from './config'
import { Logger } from './logger'
import { MemoryBudget } from './memory-budget'
import { IMAGE_EXTENSIONS, optimizeImage } from './optimizer'
import type {
  CompressionOptions,
  CompressionResult,
  FileCompressionResult
} from './types'

const BYTES_PER_MEGABYTE = 1024 * 1024
const MAX_CONCURRENCY = 16

async function collectImageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectImageFiles(filePath)))
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(filePath)
    }
  }

  return files
}

function resolveConcurrency(requested?: number): number {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new TypeError('concurrency 必须是大于 0 的整数')
  }

  return Math.min(requested ?? Math.max(1, Math.min(availableParallelism(), 4)), MAX_CONCURRENCY)
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

function summarize(results: FileCompressionResult[], timeTaken: number): CompressionResult {
  const totalOriginalBytes = results.reduce((sum, result) => sum + result.originalBytes, 0)
  const totalCompressedBytes = results.reduce((sum, result) => sum + result.finalBytes, 0)
  const savedBytes = totalOriginalBytes - totalCompressedBytes

  return {
    totalFiles: results.length,
    compressedFiles: results.filter(({ status }) => status === 'compressed').length,
    skippedFiles: results.filter(({ status }) => status === 'skipped').length,
    failedFiles: results.filter(({ status }) => status === 'failed').length,
    totalOriginalSize: totalOriginalBytes / BYTES_PER_MEGABYTE,
    totalCompressedSize: totalCompressedBytes / BYTES_PER_MEGABYTE,
    savedSize: savedBytes / BYTES_PER_MEGABYTE,
    savedPercentage: totalOriginalBytes === 0 ? 0 : (savedBytes / totalOriginalBytes) * 100,
    timeTaken
  }
}

export async function compressImages(options: CompressionOptions): Promise<CompressionResult> {
  if (!options || typeof options.directory !== 'string' || options.directory.trim() === '') {
    throw new TypeError('directory 必须是非空字符串')
  }

  const logger = new Logger(options.silent ?? false, options.color)
  const directory = path.resolve(options.directory)
  const concurrency = resolveConcurrency(options.concurrency)
  const profile = options.profile ?? 'max'
  if (profile !== 'max' && profile !== 'balanced') {
    throw new TypeError("profile 必须是 'max' 或 'balanced'")
  }
  const maxQuality = resolveMaxQuality()
  logger.start(options.directory)

  try {
    await access(directory, constants.R_OK | constants.W_OK)
    if (!(await stat(directory)).isDirectory()) throw new Error(`路径不是目录: ${directory}`)
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith('路径不是目录')
        ? error.message
        : `目录不存在或不可访问: ${directory}`
    logger.fatal(message)
    throw new Error(message, { cause: error })
  }

  const startTime = performance.now()
  const imageFiles = await collectImageFiles(directory)
  const memoryBudget = new MemoryBudget()
  const results = await mapWithConcurrency(imageFiles, concurrency, async (filePath) => {
    const result = await optimizeImage(filePath, memoryBudget, { profile, maxQuality })
    logger.file(directory, result)
    return result
  })
  const summary = summarize(results, (performance.now() - startTime) / 1000)
  logger.summary(summary)
  return summary
}

export default compressImages
export type { CompressionOptions, CompressionResult } from './types'
