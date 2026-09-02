import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp, { type Metadata, type Sharp } from 'sharp'
import type { MemoryBudget } from './memory-budget'
import {
  createExactReference,
  createVisualReference,
  hasIdenticalPixels,
  isVisuallyEquivalent,
  type ExactReference,
  type VisualReference
} from './quality'
import type { FileCompressionResult } from './types'

const runFile = promisify(execFile)
const MIN_QUALITY = 40
const MAX_SHARPNESS_FOR_LOSSY_SEARCH = 15
const MIN_AVIF_BYTES_PER_PIXEL_FOR_LOSSY_SEARCH = 0.5
const OPTIMIZER_MARKER = 'q-image-compressor:perceptual-v2'
const OPTIMIZER_XMP_COMMENT = `<!-- ${OPTIMIZER_MARKER} -->`

type SupportedFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif'
type Validation = 'exact' | 'visual'

interface Candidate {
  filePath: string
  bytes: number
}

interface SourceContext {
  filePath: string
  format: SupportedFormat
  metadata: Metadata
  originalBytes: number
  originalMode: number
  animated: boolean
  bitsPerSample: number
  width: number
  height: number
  sharpness: number
}

function formatForExtension(extension: string): SupportedFormat | undefined {
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'jpeg'
    case '.png':
      return 'png'
    case '.webp':
      return 'webp'
    case '.gif':
      return 'gif'
    case '.avif':
      return 'avif'
    default:
      return undefined
  }
}

function encodedFormat(format: SupportedFormat): string {
  return format === 'avif' ? 'heif' : format
}

function createInput(context: SourceContext, markAsOptimized = false): Sharp {
  let pipeline = sharp(context.filePath, {
    animated: context.animated,
    sequentialRead: true
  })
    .autoOrient()
    .keepIccProfile()

  if (context.bitsPerSample > 8) pipeline = pipeline.toColourspace('rgb16')
  if (markAsOptimized) {
    const existingXmp = context.metadata.xmp?.toString()
    const mergedXmp = existingXmp?.includes('</x:xmpmeta>')
      ? existingXmp.replace('</x:xmpmeta>', `${OPTIMIZER_XMP_COMMENT}</x:xmpmeta>`)
      : `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">${OPTIMIZER_XMP_COMMENT}</x:xmpmeta><?xpacket end="w"?>`
    pipeline = pipeline.withXmp(mergedXmp).withExifMerge({ IFD0: { Orientation: '1' } })
  }
  return pipeline
}

function isAlreadyOptimized(metadata: Metadata): boolean {
  return metadata.xmp?.includes(Buffer.from(OPTIMIZER_MARKER)) ?? false
}

function sameAnimation(source: Metadata, candidate: Metadata): boolean {
  return (
    (source.pages ?? 1) === (candidate.pages ?? 1) &&
    (source.pageHeight ?? source.height) === (candidate.pageHeight ?? candidate.height) &&
    (source.loop ?? 0) === (candidate.loop ?? 0) &&
    JSON.stringify(source.delay ?? []) === JSON.stringify(candidate.delay ?? [])
  )
}

class CandidateEvaluator {
  private best?: Candidate
  private exactReference?: ExactReference
  private visualReference?: VisualReference
  readonly temporaryPaths = new Set<string>()

  constructor(private readonly source: SourceContext) {}

  nextPath(): string {
    const candidatePath = path.join(
      path.dirname(this.source.filePath),
      `.${path.basename(this.source.filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    this.temporaryPaths.add(candidatePath)
    return candidatePath
  }

  async evaluate(
    candidatePath: string,
    validation: Validation,
    retainAsBest = true
  ): Promise<boolean> {
    const candidateMetadata = await sharp(candidatePath, { animated: this.source.animated }).metadata()
    const oriented = candidateMetadata.autoOrient ?? candidateMetadata
    const structureIsValid =
      candidateMetadata.format === encodedFormat(this.source.format) &&
      oriented.width === this.source.width &&
      oriented.height === this.source.height &&
      (!this.source.animated || sameAnimation(this.source.metadata, candidateMetadata)) &&
      (validation !== 'exact' ||
        (candidateMetadata.bitsPerSample ?? 8) === this.source.bitsPerSample)

    const bytes = (await stat(candidatePath)).size
    if (
      retainAsBest &&
      (bytes >= this.source.originalBytes ||
        (this.best !== undefined && bytes >= this.best.bytes))
    ) {
      await rm(candidatePath, { force: true })
      return false
    }

    let qualityIsValid = false
    if (structureIsValid && validation === 'exact') {
      this.exactReference ??= await createExactReference(
        this.source.filePath,
        this.source.animated,
        this.source.bitsPerSample
      )
      qualityIsValid = await hasIdenticalPixels(
        candidatePath,
        this.exactReference,
        this.source.animated
      )
    } else if (structureIsValid) {
      this.visualReference ??= await createVisualReference(
        this.source.filePath,
        this.source.metadata.hasAlpha ?? false
      )
      qualityIsValid = await isVisuallyEquivalent(candidatePath, this.visualReference)
    }

    if (
      qualityIsValid &&
      retainAsBest &&
      bytes < this.source.originalBytes &&
      (this.best === undefined || bytes < this.best.bytes)
    ) {
      if (this.best) await rm(this.best.filePath, { force: true })
      this.best = { filePath: candidatePath, bytes }
    } else {
      await rm(candidatePath, { force: true })
    }

    return qualityIsValid
  }

  async canUsePngPalette(): Promise<boolean> {
    if (this.source.bitsPerSample > 8) return false

    this.exactReference ??= await createExactReference(
      this.source.filePath,
      this.source.animated,
      this.source.bitsPerSample
    )
    const colors = new Set<number>()
    const { data, channels } = this.exactReference
    for (let index = 0; index < data.length; index += channels) {
      colors.add(
        ((data[index] << 24) |
          (data[index + 1] << 16) |
          (data[index + 2] << 8) |
          data[index + 3]) >>> 0
      )
      if (colors.size > 256) return false
    }
    return true
  }

  async commit(): Promise<FileCompressionResult | undefined> {
    if (!this.best) return undefined

    await chmod(this.best.filePath, this.source.originalMode)
    await rename(this.best.filePath, this.source.filePath)
    return {
      filePath: this.source.filePath,
      status: 'compressed',
      originalBytes: this.source.originalBytes,
      finalBytes: this.best.bytes
    }
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled(
      [...this.temporaryPaths].map((candidatePath) => rm(candidatePath, { force: true }))
    )
  }
}

async function encodeAndEvaluate(
  evaluator: CandidateEvaluator,
  validation: Validation,
  encode: (outputPath: string) => Promise<void>,
  retainAsBest = true
): Promise<boolean> {
  const outputPath = evaluator.nextPath()
  await encode(outputPath)
  return evaluator.evaluate(outputPath, validation, retainAsBest)
}

async function searchQualityBoundary(
  evaluator: CandidateEvaluator,
  encode: (quality: number, outputPath: string, finalEffort: boolean) => Promise<void>
): Promise<void> {
  const tested = new Map<number, boolean>()
  const finalTested = new Map<number, boolean>()

  const test = async (quality: number, finalEffort = false): Promise<boolean> => {
    if (!finalEffort && tested.has(quality)) return tested.get(quality) ?? false
    const cache = finalEffort ? finalTested : tested
    if (cache.has(quality)) return cache.get(quality) ?? false
    const passed = await encodeAndEvaluate(
      evaluator,
      'visual',
      (outputPath) => encode(quality, outputPath, finalEffort),
      finalEffort
    )
    cache.set(quality, passed)
    return passed
  }

  if (!(await test(100))) return

  let lowerFailed = MIN_QUALITY - 1
  let upperPassed = 100
  if (await test(90)) upperPassed = 90
  else lowerFailed = 90

  while (upperPassed - lowerFailed > 2) {
    const quality = Math.floor((upperPassed + lowerFailed) / 2)
    if (await test(quality)) upperPassed = quality
    else lowerFailed = quality
  }

  let finalPassed = false
  let finalLowerFailed = Math.max(MIN_QUALITY - 1, upperPassed - 3)
  for (
    let quality = Math.max(MIN_QUALITY, upperPassed - 2);
    quality <= Math.min(100, upperPassed + 2);
    quality += 1
  ) {
    if (await test(quality, true)) finalPassed = true
    else finalLowerFailed = Math.max(finalLowerFailed, quality)
  }

  if (!finalPassed && upperPassed + 2 < 100 && (await test(100, true))) {
    let finalUpperPassed = 100
    while (finalUpperPassed - finalLowerFailed > 2) {
      const quality = Math.floor((finalUpperPassed + finalLowerFailed) / 2)
      if (await test(quality, true)) finalUpperPassed = quality
      else finalLowerFailed = quality
    }
  }
}

let jpegtranAvailable: boolean | undefined

async function tryJpegtran(
  evaluator: CandidateEvaluator,
  sourcePath: string,
  progressive: boolean
): Promise<void> {
  if (
    jpegtranAvailable === false ||
    process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN === '1'
  ) {
    return
  }

  const outputPath = evaluator.nextPath()
  const executable = process.env.JPEGTRAN_PATH || 'jpegtran'
  const args = ['-copy', 'all', '-optimize']
  if (progressive) args.push('-progressive')
  args.push('-outfile', outputPath, sourcePath)

  try {
    await runFile(executable, args, { timeout: 60_000, maxBuffer: 1024 * 1024 })
    jpegtranAvailable = true
    await evaluator.evaluate(outputPath, 'exact')
  } catch (error) {
    await rm(outputPath, { force: true })
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') jpegtranAvailable = false
  }
}

async function optimizeJpeg(
  context: SourceContext,
  evaluator: CandidateEvaluator,
  profile: 'max' | 'balanced'
): Promise<void> {
  await tryJpegtran(evaluator, context.filePath, false)
  await tryJpegtran(evaluator, context.filePath, true)
  if (profile === 'balanced' && context.sharpness > MAX_SHARPNESS_FOR_LOSSY_SEARCH) return

  for (const chromaSubsampling of ['4:4:4', '4:2:0']) {
    await searchQualityBoundary(evaluator, async (quality, outputPath) => {
      await createInput(context, true)
        .jpeg({
          quality,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling,
          trellisQuantisation: true,
          overshootDeringing: true,
          optimiseScans: true
        })
        .toFile(outputPath)
    })
  }
}

async function optimizePng(context: SourceContext, evaluator: CandidateEvaluator): Promise<void> {
  for (const adaptiveFiltering of [false, true]) {
    await encodeAndEvaluate(evaluator, 'exact', async (outputPath) => {
      await createInput(context)
        .png({ compressionLevel: 9, adaptiveFiltering })
        .toFile(outputPath)
    })
  }

  if (context.metadata.isPalette || (await evaluator.canUsePngPalette())) {
    await encodeAndEvaluate(evaluator, 'exact', async (outputPath) => {
      await createInput(context)
        .png({
          compressionLevel: 9,
          palette: true,
          quality: 100,
          colours: 256,
          effort: 10,
          dither: 0
        })
        .toFile(outputPath)
    })
  }
}

async function optimizeWebp(
  context: SourceContext,
  evaluator: CandidateEvaluator,
  profile: 'max' | 'balanced'
): Promise<void> {
  await encodeAndEvaluate(evaluator, 'exact', async (outputPath) => {
    await createInput(context)
      .webp({ lossless: true, effort: profile === 'max' ? 6 : 4, minSize: true, exact: true })
      .toFile(outputPath)
  })

  if (context.animated) return
  if (profile === 'balanced' && context.sharpness > MAX_SHARPNESS_FOR_LOSSY_SEARCH) return
  await searchQualityBoundary(evaluator, async (quality, outputPath) => {
    await createInput(context, true)
      .webp({
        quality,
        alphaQuality: 100,
        effort: profile === 'max' ? 6 : 4,
        smartSubsample: true,
        smartDeblock: true,
        exact: true
      })
      .toFile(outputPath)
  })
}

async function optimizeGif(
  context: SourceContext,
  evaluator: CandidateEvaluator,
  profile: 'max' | 'balanced'
): Promise<void> {
  for (const reuse of [true, false]) {
    await encodeAndEvaluate(evaluator, 'exact', async (outputPath) => {
      await createInput(context)
        .gif({
          reuse,
          effort: profile === 'max' ? 10 : 7,
          dither: 0,
          interFrameMaxError: 0,
          interPaletteMaxError: 0,
          keepDuplicateFrames: true
        })
        .toFile(outputPath)
    })
  }
}

async function optimizeAvif(
  context: SourceContext,
  evaluator: CandidateEvaluator,
  profile: 'max' | 'balanced'
): Promise<void> {
  const bitdepth = context.bitsPerSample === 10 || context.bitsPerSample === 12
    ? context.bitsPerSample
    : 8

  const losslessProbePath = evaluator.nextPath()
  await createInput(context)
    .avif({ lossless: true, effort: 6, chromaSubsampling: '4:4:4', bitdepth })
    .toFile(losslessProbePath)
  const losslessCanSaveSpace = (await stat(losslessProbePath)).size < context.originalBytes
  await evaluator.evaluate(losslessProbePath, 'exact', false)

  if (losslessCanSaveSpace) {
    await encodeAndEvaluate(evaluator, 'exact', async (outputPath) => {
      await createInput(context)
        .avif({ lossless: true, effort: 9, chromaSubsampling: '4:4:4', bitdepth })
        .toFile(outputPath)
    })
  }
  const bytesPerPixel = context.originalBytes / (context.width * context.height)
  if (
    profile === 'balanced' &&
    (context.sharpness > MAX_SHARPNESS_FOR_LOSSY_SEARCH ||
      bytesPerPixel < MIN_AVIF_BYTES_PER_PIXEL_FOR_LOSSY_SEARCH)
  ) {
    return
  }

  for (const chromaSubsampling of ['4:4:4', '4:2:0']) {
    await searchQualityBoundary(
      evaluator,
      async (quality, outputPath, finalEffort) => {
        await createInput(context, true)
          .avif({
            quality,
            effort: finalEffort ? (profile === 'max' ? 9 : 6) : 4,
            chromaSubsampling,
            bitdepth,
            tune: 'ssim'
          })
          .toFile(outputPath)
      }
    )
  }
}

export async function optimizeImage(
  filePath: string,
  memoryBudget?: MemoryBudget,
  profile: 'max' | 'balanced' = 'max'
): Promise<FileCompressionResult> {
  const format = formatForExtension(path.extname(filePath).toLowerCase())
  let originalBytes = 0
  let releaseMemory: (() => void) | undefined

  try {
    const original = await stat(filePath)
    originalBytes = original.size
    if (!format) {
      return { filePath, status: 'skipped', originalBytes, finalBytes: originalBytes }
    }

    const animated = format === 'gif' || format === 'webp'
    const metadata = await sharp(filePath, { animated }).metadata()
    const pages = metadata.pages ?? 1
    if (format === 'avif' && pages > 1) {
      return {
        filePath,
        status: 'skipped',
        originalBytes,
        finalBytes: originalBytes,
        reason: '多帧 AVIF 保持原样'
      }
    }
    if (isAlreadyOptimized(metadata)) {
      return {
        filePath,
        status: 'skipped',
        originalBytes,
        finalBytes: originalBytes,
        reason: '已通过感知质量优化'
      }
    }

    const oriented = metadata.autoOrient ?? metadata
    if (!oriented.width || !oriented.height) throw new Error('无法读取图片尺寸')
    const supportsLossySearch = format === 'jpeg' || format === 'webp' || format === 'avif'
    const bytesPerPixel = supportsLossySearch
      ? 32
      : metadata.bitsPerSample && metadata.bitsPerSample > 8
        ? 20
        : 12
    releaseMemory = await memoryBudget?.acquire(oriented.width * oriented.height * bytesPerPixel)
    const sharpness = animated || !supportsLossySearch ? 0 : (await sharp(filePath).stats()).sharpness
    const context: SourceContext = {
      filePath,
      format,
      metadata,
      originalBytes,
      originalMode: original.mode,
      animated,
      bitsPerSample: metadata.bitsPerSample ?? 8,
      width: oriented.width,
      height: oriented.height,
      sharpness
    }
    const evaluator = new CandidateEvaluator(context)

    try {
      if (format === 'jpeg') await optimizeJpeg(context, evaluator, profile)
      else if (format === 'png') await optimizePng(context, evaluator)
      else if (format === 'webp') await optimizeWebp(context, evaluator, profile)
      else if (format === 'gif') await optimizeGif(context, evaluator, profile)
      else await optimizeAvif(context, evaluator, profile)

      return (
        (await evaluator.commit()) ?? {
          filePath,
          status: 'skipped',
          originalBytes,
          finalBytes: originalBytes,
          reason: '原文件已是最佳合格结果'
        }
      )
    } finally {
      await evaluator.cleanup()
    }
  } catch (error) {
    return {
      filePath,
      status: 'failed',
      originalBytes,
      finalBytes: originalBytes,
      reason: error instanceof Error ? error.message : String(error)
    }
  } finally {
    releaseMemory?.()
  }
}
