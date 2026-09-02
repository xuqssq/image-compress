import sharp from 'sharp'
import { ssim } from 'ssim.js'

const SSIM_THRESHOLD = 0.995
const PSNR_THRESHOLD = 40
const MEAN_ABSOLUTE_ERROR_THRESHOLD = 3
const P99_ERROR_THRESHOLD = 12
const MAX_ERROR_THRESHOLD = 96
const SHARPNESS_RATIO_MIN = 0.98
const SHARPNESS_RATIO_MAX = 1.05

type PixelDepth = 'uchar' | 'ushort'

interface PixelData {
  data: Buffer
  width: number
  height: number
  channels: number
}

export interface ExactReference extends PixelData {
  depth: PixelDepth
}

export interface VisualReference extends PixelData {
  sharpness: number
  hasAlpha: boolean
  ssimPixels: PixelData
}

async function readPixels(
  filePath: string,
  animated: boolean,
  depth: PixelDepth,
  visual: boolean
): Promise<PixelData> {
  let pipeline = sharp(filePath, { animated }).autoOrient()
  if (visual) pipeline = pipeline.toColourspace('srgb')

  const { data, info } = await pipeline
    .ensureAlpha()
    .raw({ depth })
    .toBuffer({ resolveWithObject: true })

  return { data, width: info.width, height: info.height, channels: info.channels }
}

async function readSsimPixels(filePath: string): Promise<PixelData> {
  const { data, info } = await sharp(filePath)
    .autoOrient()
    .toColourspace('srgb')
    .ensureAlpha()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  return { data, width: info.width, height: info.height, channels: info.channels }
}

function luminanceAt(pixels: PixelData, pixelIndex: number): number {
  const offset = pixelIndex * pixels.channels
  return (
    pixels.data[offset] * 0.2126 +
    pixels.data[offset + 1] * 0.7152 +
    pixels.data[offset + 2] * 0.0722
  )
}

function calculateSharpness(pixels: PixelData): number {
  if (pixels.width < 2 || pixels.height < 2) return 0

  let difference = 0
  let comparisons = 0
  for (let y = 0; y < pixels.height; y += 1) {
    for (let x = 0; x < pixels.width; x += 1) {
      const pixelIndex = y * pixels.width + x
      const value = luminanceAt(pixels, pixelIndex)
      if (x > 0) {
        difference += Math.abs(value - luminanceAt(pixels, pixelIndex - 1))
        comparisons += 1
      }
      if (y > 0) {
        difference += Math.abs(value - luminanceAt(pixels, pixelIndex - pixels.width))
        comparisons += 1
      }
    }
  }

  return comparisons === 0 ? 0 : difference / comparisons
}

function hasSameGeometry(source: PixelData, candidate: PixelData): boolean {
  return (
    source.width === candidate.width &&
    source.height === candidate.height &&
    source.channels === candidate.channels &&
    source.data.length === candidate.data.length
  )
}

export async function createExactReference(
  filePath: string,
  animated: boolean,
  bitsPerSample: number
): Promise<ExactReference> {
  const depth: PixelDepth = bitsPerSample > 8 ? 'ushort' : 'uchar'
  return { ...(await readPixels(filePath, animated, depth, false)), depth }
}

export async function hasIdenticalPixels(
  candidatePath: string,
  reference: ExactReference,
  animated: boolean
): Promise<boolean> {
  const candidate = await readPixels(candidatePath, animated, reference.depth, false)
  return hasSameGeometry(reference, candidate) && reference.data.equals(candidate.data)
}

export async function createVisualReference(
  filePath: string,
  hasAlpha: boolean
): Promise<VisualReference> {
  const [pixels, ssimPixels] = await Promise.all([
    readPixels(filePath, false, 'uchar', true),
    readSsimPixels(filePath)
  ])
  return { ...pixels, sharpness: calculateSharpness(pixels), hasAlpha, ssimPixels }
}

export async function isVisuallyEquivalent(
  candidatePath: string,
  reference: VisualReference
): Promise<boolean> {
  const candidate = await readPixels(candidatePath, false, 'uchar', true)
  if (!hasSameGeometry(reference, candidate)) return false

  const histogram = new Uint32Array(256)
  let absoluteError = 0
  let squaredError = 0
  let maximumError = 0
  let comparedChannels = 0

  for (let index = 0; index < reference.data.length; index += reference.channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(reference.data[index + channel] - candidate.data[index + channel])
      histogram[error] += 1
      absoluteError += error
      squaredError += error * error
      maximumError = Math.max(maximumError, error)
      comparedChannels += 1
    }

    if (
      reference.hasAlpha &&
      reference.data[index + 3] !== candidate.data[index + 3]
    ) {
      return false
    }
  }

  const targetRank = Math.ceil(comparedChannels * 0.99)
  let cumulative = 0
  let p99Error = 255
  for (let error = 0; error < histogram.length; error += 1) {
    cumulative += histogram[error]
    if (cumulative >= targetRank) {
      p99Error = error
      break
    }
  }

  const meanSquaredError = squaredError / comparedChannels
  const psnr =
    meanSquaredError === 0
      ? Number.POSITIVE_INFINITY
      : 10 * Math.log10((255 * 255) / meanSquaredError)
  const sharpness = calculateSharpness(candidate)
  const sharpnessRatio = reference.sharpness === 0 ? 1 : sharpness / reference.sharpness
  if (
    psnr < PSNR_THRESHOLD ||
    absoluteError / comparedChannels > MEAN_ABSOLUTE_ERROR_THRESHOLD ||
    p99Error > P99_ERROR_THRESHOLD ||
    maximumError > MAX_ERROR_THRESHOLD ||
    sharpnessRatio < SHARPNESS_RATIO_MIN ||
    sharpnessRatio > SHARPNESS_RATIO_MAX
  ) {
    return false
  }

  const candidateSsimPixels = await readSsimPixels(candidatePath)
  if (!hasSameGeometry(reference.ssimPixels, candidateSsimPixels)) return false

  const sourceImage = {
    data: new Uint8ClampedArray(
      reference.ssimPixels.data.buffer,
      reference.ssimPixels.data.byteOffset,
      reference.ssimPixels.data.byteLength
    ),
    width: reference.ssimPixels.width,
    height: reference.ssimPixels.height
  }
  const candidateImage = {
    data: new Uint8ClampedArray(
      candidateSsimPixels.data.buffer,
      candidateSsimPixels.data.byteOffset,
      candidateSsimPixels.data.byteLength
    ),
    width: candidateSsimPixels.width,
    height: candidateSsimPixels.height
  }

  return (
    ssim(sourceImage, candidateImage, {
      ssim: 'weber',
      windowSize: 11,
      downsample: false,
      rgb2grayVersion: 'original'
    }).mssim >= SSIM_THRESHOLD
  )
}
