import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const temporaryDirectories: string[] = []

export async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'q-image-compressor-'))
  temporaryDirectories.push(directory)
  return directory
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
}

export async function createNoiseImage(
  filePath: string,
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif',
  width = 320,
  height = 240
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })

  const pixels = Buffer.allocUnsafe(width * height * 3)
  let state = 0x12345678

  for (let index = 0; index < pixels.length; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0
    pixels[index] = state >>> 24
  }

  const image = sharp(pixels, { raw: { width, height, channels: 3 } })

  if (format === 'jpeg') {
    await image.jpeg({ quality: 98, chromaSubsampling: '4:4:4' }).toFile(filePath)
    return
  }

  if (format === 'png') {
    await image.png({ compressionLevel: 0 }).toFile(filePath)
    return
  }

  if (format === 'webp') {
    await image.webp({ quality: 98, smartSubsample: true }).toFile(filePath)
    return
  }

  if (format === 'gif') {
    await image.gif({ effort: 10, dither: 0 }).toFile(filePath)
    return
  }

  await image.avif({ quality: 98, effort: 4, chromaSubsampling: '4:4:4' }).toFile(filePath)
}

export async function createAnimatedImage(
  filePath: string,
  format: 'gif' | 'webp'
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const frames = await Promise.all(
    ['#ff3366', '#3366ff'].map((background) =>
      sharp({ create: { width: 32, height: 24, channels: 4, background } })
        .png()
        .toBuffer()
    )
  )
  const image = sharp(frames, { join: { animated: true } })

  if (format === 'gif') {
    await image
      .gif({ delay: [80, 120], loop: 2, effort: 1, keepDuplicateFrames: true })
      .toFile(filePath)
    return
  }

  await image
    .webp({ delay: [80, 120], loop: 2, lossless: true, effort: 0 })
    .toFile(filePath)
}

export async function createGradientJpeg(
  filePath: string,
  quality = 80,
  orientation?: number,
  xmp?: string,
  imageDescription?: string
): Promise<void> {
  const width = 640
  const height = 400
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      pixels[offset] = Math.round((x / width) * 255)
      pixels[offset + 1] = Math.round((y / height) * 255)
      pixels[offset + 2] = Math.round(((x + y) / (width + height)) * 255)
    }
  }

  let image = sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({
    quality,
    chromaSubsampling: '4:4:4'
  })
  if (orientation !== undefined) image = image.withMetadata({ orientation })
  if (xmp !== undefined) image = image.withXmp(xmp)
  if (imageDescription !== undefined) {
    image = image.withExifMerge({ IFD0: { ImageDescription: imageDescription } })
  }
  await image.toFile(filePath)
}

export async function createCheckerboardJpeg(filePath: string): Promise<void> {
  const width = 640
  const height = 480
  const pixels = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 32 : 224
      const offset = (y * width + x) * 3
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toFile(filePath)
}

export async function createSixteenBitPng(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await sharp({ create: { width: 128, height: 96, channels: 3, background: '#808080' } })
    .toColourspace('rgb16')
    .linear(1.001, 1)
    .png({ compressionLevel: 0 })
    .toFile(filePath)
}

export async function decodedPixels(filePath: string): Promise<Buffer> {
  return sharp(filePath).ensureAlpha().raw().toBuffer()
}

export async function decodedAnimatedPixels(filePath: string): Promise<Buffer> {
  return sharp(filePath, { animated: true }).ensureAlpha().raw().toBuffer()
}

export async function fileBytes(filePath: string): Promise<Buffer> {
  return readFile(filePath)
}
