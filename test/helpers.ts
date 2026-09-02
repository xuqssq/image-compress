import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transformer } from '@napi-rs/image'

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

function createPixels(width: number, height: number): Buffer {
  const pixels = Buffer.allocUnsafe(width * height * 4)
  let state = 0x12345678

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      state = (1664525 * state + 1013904223) >>> 0
      const noise = (state >>> 28) - 8
      pixels[offset] = Math.max(0, Math.min(255, Math.round((x / width) * 255) + noise))
      pixels[offset + 1] = Math.max(0, Math.min(255, Math.round((y / height) * 255) + noise))
      pixels[offset + 2] = Math.max(
        0,
        Math.min(255, Math.round(((x + y) / (width + height)) * 255) + noise)
      )
      pixels[offset + 3] = 255
    }
  }

  return pixels
}

export type EncodableFormat =
  | 'jpeg'
  | 'png'
  | 'bmp'
  | 'ico'
  | 'tiff'
  | 'pnm'
  | 'webp'
  | 'avif'

export async function createImage(
  filePath: string,
  format: EncodableFormat,
  width = 320,
  height = 240,
  quality = 98
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const transformer = Transformer.fromRgbaPixels(createPixels(width, height), width, height)
  let output: Buffer

  if (format === 'jpeg') output = await transformer.jpeg(quality)
  else if (format === 'png') output = await transformer.png()
  else if (format === 'webp') output = await transformer.webp(quality)
  else if (format === 'avif') output = await transformer.avif({ quality, speed: 4, threads: 2 })
  else output = await transformer[format]()

  await writeFile(filePath, output)
}

export async function createUnsupportedFile(
  filePath: string,
  contents = 'unsupported fixture'
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
}

export async function metadata(filePath: string) {
  return new Transformer(await readFile(filePath)).metadata(true)
}

export async function decodedPixels(filePath: string): Promise<Buffer> {
  return new Transformer(await readFile(filePath)).rawPixels()
}

export async function fileBytes(filePath: string): Promise<Buffer> {
  return readFile(filePath)
}
