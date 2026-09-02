import { randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ChromaSubsampling,
  PngRowFilter,
  Transformer,
  compressJpeg,
  losslessCompressPng,
  pngQuantize,
  type Metadata
} from '@napi-rs/image'
import type { MemoryBudget } from './memory-budget'
import type { FileCompressionResult } from './types'

type ReencodableFormat =
  | 'jpeg'
  | 'png'
  | 'bmp'
  | 'ico'
  | 'tiff'
  | 'webp'
  | 'avif'
  | 'heic'
  | 'pnm'
  | 'tga'
  | 'farbfeld'

interface OptimizerOptions {
  maxQuality: number
  profile: 'max' | 'balanced'
}

const EXTENSION_FORMATS = new Map<string, ReencodableFormat>([
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.jpe', 'jpeg'],
  ['.jfif', 'jpeg'],
  ['.png', 'png'],
  ['.bmp', 'bmp'],
  ['.ico', 'ico'],
  ['.tif', 'tiff'],
  ['.tiff', 'tiff'],
  ['.webp', 'webp'],
  ['.avif', 'avif'],
  ['.heic', 'heic'],
  ['.heif', 'heic'],
  ['.pnm', 'pnm'],
  ['.pbm', 'pnm'],
  ['.pgm', 'pnm'],
  ['.ppm', 'pnm'],
  ['.pam', 'pnm'],
  ['.tga', 'tga'],
  ['.ff', 'farbfeld'],
  ['.farbfeld', 'farbfeld']
])

const RECOGNIZED_UNSUPPORTED = new Map<string, string>([
  ['.gif', '不支持 GIF'],
  ['.dds', 'DDS 只能解码，不能保持格式编码'],
  ['.exr', 'OpenEXR 只能解码，不能保持格式编码'],
  ['.svg', 'SVG 只能解码，不能保持格式编码'],
  ['.svgz', 'SVGZ 只能解码，不能保持格式编码']
])

export const IMAGE_EXTENSIONS = new Set([
  ...EXTENSION_FORMATS.keys(),
  ...RECOGNIZED_UNSUPPORTED.keys()
])

function normalizedDimensions(metadata: Metadata): { width: number; height: number } {
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height }
}

function formatMatches(expected: ReencodableFormat, actual: string): boolean {
  if (expected === 'heic') return actual === 'heic' || actual === 'heif'
  return actual === expected
}

async function encodePng(
  source: Buffer,
  options: OptimizerOptions
): Promise<Buffer[]> {
  const candidates: Buffer[] = []
  candidates.push(
    await losslessCompressPng(source, {
      force: true,
      fixErrors: false,
      filter:
        options.profile === 'max'
          ? [
              PngRowFilter.None,
              PngRowFilter.Sub,
              PngRowFilter.Up,
              PngRowFilter.Average,
              PngRowFilter.Paeth
            ]
          : undefined,
      strip: false
    })
  )

  try {
    candidates.push(
      await pngQuantize(source, {
        minQuality: Math.max(0, options.maxQuality - 15),
        maxQuality: options.maxQuality,
        speed: options.profile === 'max' ? 1 : 5,
        posterization: 0
      })
    )
  } catch {
    // Some images cannot meet the requested quantizer quality.
  }

  return candidates
}

async function encodeCandidates(
  source: Buffer,
  format: ReencodableFormat,
  metadata: Metadata,
  options: OptimizerOptions
): Promise<Buffer[]> {
  if (format === 'png') return encodePng(source, options)

  if (format === 'jpeg') {
    if (metadata.orientation && metadata.orientation !== 1) {
      return [await new Transformer(source).rotate().jpeg(options.maxQuality)]
    }
    return [
      await compressJpeg(source, {
        quality: options.maxQuality,
        optimizeScans: true
      })
    ]
  }

  const transformer = new Transformer(source).rotate()
  if (format === 'webp') return [await transformer.webp(options.maxQuality)]
  if (format === 'avif') {
    return [
      await transformer.avif({
        quality: options.maxQuality,
        alphaQuality: options.maxQuality,
        speed: options.profile === 'max' ? 1 : 4,
        threads: 0,
        chromaSubsampling: ChromaSubsampling.Yuv420
      })
    ]
  }
  if (format === 'heic') {
    const usesHighBitDepth = metadata.colorType >= 4 && metadata.colorType <= 7
    return [
      await transformer.heic({
        quality: options.maxQuality,
        bitDepth: usesHighBitDepth ? 10 : 8
      })
    ]
  }
  if (format === 'bmp') return [await transformer.bmp()]
  if (format === 'ico') return [await transformer.ico()]
  if (format === 'tiff') return [await transformer.tiff()]
  if (format === 'pnm') return [await transformer.pnm()]
  if (format === 'tga') return [await transformer.tga()]
  return [await transformer.farbfeld()]
}

async function selectSmallestValidCandidate(
  candidates: Buffer[],
  format: ReencodableFormat,
  expectedDimensions: { width: number; height: number },
  originalBytes: number
): Promise<Buffer | undefined> {
  let best: Buffer | undefined

  for (const candidate of candidates) {
    if (candidate.length >= originalBytes || (best && candidate.length >= best.length)) continue

    try {
      const metadata = await new Transformer(candidate).metadata()
      if (
        formatMatches(format, metadata.format) &&
        metadata.width === expectedDimensions.width &&
        metadata.height === expectedDimensions.height
      ) {
        best = candidate
      }
    } catch {
      // Reject output that the selected image runtime cannot read back.
    }
  }

  return best
}

export async function optimizeImage(
  filePath: string,
  memoryBudget: MemoryBudget,
  options: OptimizerOptions
): Promise<FileCompressionResult> {
  const extension = path.extname(filePath).toLowerCase()
  const unsupportedReason = RECOGNIZED_UNSUPPORTED.get(extension)
  let originalBytes = 0
  let temporaryPath: string | undefined
  let releaseMemory: (() => void) | undefined

  try {
    const original = await stat(filePath)
    originalBytes = original.size
    if (unsupportedReason) {
      return {
        filePath,
        status: 'skipped',
        originalBytes,
        finalBytes: originalBytes,
        reason: unsupportedReason
      }
    }

    const format = EXTENSION_FORMATS.get(extension)
    if (!format) {
      return { filePath, status: 'skipped', originalBytes, finalBytes: originalBytes }
    }

    const source = await readFile(filePath)
    const metadata = await new Transformer(source).metadata(true)
    const dimensions = normalizedDimensions(metadata)
    releaseMemory = await memoryBudget.acquire(dimensions.width * dimensions.height * 12)

    const candidates = await encodeCandidates(source, format, metadata, options)
    const best = await selectSmallestValidCandidate(
      candidates,
      format,
      dimensions,
      originalBytes
    )
    if (!best) {
      return {
        filePath,
        status: 'skipped',
        originalBytes,
        finalBytes: originalBytes,
        reason: '原文件已是最小结果'
      }
    }

    temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    await writeFile(temporaryPath, best)
    await chmod(temporaryPath, original.mode)
    await rename(temporaryPath, filePath)
    return {
      filePath,
      status: 'compressed',
      originalBytes,
      finalBytes: best.length
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
    if (temporaryPath) await rm(temporaryPath, { force: true })
  }
}
