import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { afterEach, describe, it } from 'node:test'
import path from 'node:path'
import sharp from 'sharp'
import { compressImages } from '../src/index'
import {
  cleanupTemporaryDirectories,
  createAnimatedImage,
  createCheckerboardJpeg,
  createGradientJpeg,
  createNoiseImage,
  createSixteenBitPng,
  createTemporaryDirectory,
  decodedAnimatedPixels,
  decodedPixels,
  fileBytes
} from './helpers'

afterEach(cleanupTemporaryDirectories)

describe('compressImages', () => {
  it('recursively processes supported images and returns consistent statistics', async () => {
    const directory = await createTemporaryDirectory()
    const rootImage = path.join(directory, 'root.jpg')
    const nestedImage = path.join(directory, 'nested', 'child.png')
    await Promise.all([
      createNoiseImage(rootImage, 'jpeg'),
      createNoiseImage(nestedImage, 'png')
    ])

    const result = await compressImages({ directory, silent: true })

    assert.equal(result.totalFiles, 2)
    assert.equal(
      result.compressedFiles + result.skippedFiles + result.failedFiles,
      result.totalFiles
    )
    assert.ok(result.totalOriginalSize > 0)
    assert.ok(result.totalCompressedSize > 0)
    assert.ok(result.totalCompressedSize <= result.totalOriginalSize)
    assert.ok(result.timeTaken >= 0)
  })

  it('preserves the encoded format and exact PNG pixels', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'photo.png')
    await createNoiseImage(imagePath, 'png')
    const pixelsBefore = await decodedPixels(imagePath)

    await compressImages({ directory, silent: true })

    const metadata = await sharp(imagePath).metadata()
    const pixelsAfter = await decodedPixels(imagePath)
    assert.equal(metadata.format, 'png')
    assert.deepEqual(pixelsAfter, pixelsBefore)
  })

  it('never replaces an image with a larger file', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'already-small.png')
    await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#ff3366' }
    })
      .png({ compressionLevel: 9 })
      .toFile(imagePath)
    const bytesBefore = await fileBytes(imagePath)

    await compressImages({ directory, silent: true })

    const bytesAfter = await fileBytes(imagePath)
    assert.ok(bytesAfter.length <= bytesBefore.length)
    assert.equal((await sharp(imagePath).metadata()).format, 'png')
  })

  it('keeps concurrent invocations isolated', async () => {
    const firstDirectory = await createTemporaryDirectory()
    const secondDirectory = await createTemporaryDirectory()
    await Promise.all([
      createNoiseImage(path.join(firstDirectory, 'first.jpg'), 'jpeg'),
      createNoiseImage(path.join(secondDirectory, 'second.jpg'), 'jpeg')
    ])

    const [first, second] = await Promise.all([
      compressImages({ directory: firstDirectory, silent: true }),
      compressImages({ directory: secondDirectory, silent: true })
    ])

    assert.equal(first.totalFiles, 1)
    assert.equal(second.totalFiles, 1)
  })

  it('preserves every supported encoded format', async () => {
    const directory = await createTemporaryDirectory()
    const fixtures = [
      ['image.jpg', 'jpeg', 'jpeg'],
      ['image.png', 'png', 'png'],
      ['image.webp', 'webp', 'webp'],
      ['image.gif', 'gif', 'gif'],
      ['image.avif', 'avif', 'heif']
    ] as const

    await Promise.all(
      fixtures.map(([name, encoder]) =>
        createNoiseImage(path.join(directory, name), encoder, 96, 64)
      )
    )
    await compressImages({ directory, silent: true, concurrency: 2 })

    for (const [name, , expectedFormat] of fixtures) {
      assert.equal((await sharp(path.join(directory, name)).metadata()).format, expectedFormat)
    }
  })

  it('does not repeatedly rewrite an already optimized JPEG', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'photo.jpg')
    await createNoiseImage(imagePath, 'jpeg')

    await compressImages({ directory, silent: true })
    const firstPass = await fileBytes(imagePath)
    await compressImages({ directory, silent: true })
    const secondPass = await fileBytes(imagePath)

    assert.deepEqual(secondPass, firstPass)
  })

  it('does not accumulate generational loss on a smooth JPEG', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'gradient.jpg')
    await createGradientJpeg(imagePath, 80)

    await compressImages({ directory, silent: true, concurrency: 1 })
    const firstPass = await fileBytes(imagePath)
    await compressImages({ directory, silent: true, concurrency: 1 })
    const secondPass = await fileBytes(imagePath)
    await compressImages({ directory, silent: true, concurrency: 1 })
    const thirdPass = await fileBytes(imagePath)

    assert.deepEqual(secondPass, firstPass)
    assert.deepEqual(thirdPass, firstPass)
  })

  it('finds a high-quality JPEG boundary beyond the former fixed quality grid', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'quality-100.jpg')
    const userXmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="KEEP-ME-UNIQUE"/>
      </rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
    await createGradientJpeg(
      imagePath,
      100,
      undefined,
      userXmp,
      'USER-DESCRIPTION-KEEP'
    )
    const before = await fileBytes(imagePath)
    const previousSetting = process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN
    process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN = '1'

    try {
      const result = await compressImages({ directory, silent: true, concurrency: 1 })
      const after = await fileBytes(imagePath)
      const metadata = await sharp(imagePath).metadata()
      assert.equal(result.compressedFiles, 1)
      assert.ok(after.length < before.length)
      assert.ok(metadata.xmp?.toString().includes('KEEP-ME-UNIQUE'))
      assert.ok(metadata.xmp?.toString().includes('q-image-compressor:perceptual-v2'))
      assert.ok(metadata.exif?.includes(Buffer.from('USER-DESCRIPTION-KEEP')))
    } finally {
      if (previousSetting === undefined) {
        delete process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN
      } else {
        process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN = previousSetting
      }
    }
  })

  it('does not prune high-sharpness JPEGs in the default max profile', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'checkerboard.jpg')
    await createCheckerboardJpeg(imagePath)
    const before = await fileBytes(imagePath)
    const previousSetting = process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN
    process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN = '1'

    try {
      const result = await compressImages({ directory, silent: true, concurrency: 1 })
      assert.equal(result.compressedFiles, 1)
      assert.ok((await fileBytes(imagePath)).length < before.length)
    } finally {
      if (previousSetting === undefined) {
        delete process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN
      } else {
        process.env.Q_IMAGE_COMPRESSOR_DISABLE_JPEGTRAN = previousSetting
      }
    }
  })

  it('preserves 16-bit PNG depth and ushort pixels exactly', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'high-depth.png')
    await createSixteenBitPng(imagePath)
    const before = await sharp(imagePath).ensureAlpha().raw({ depth: 'ushort' }).toBuffer()

    await compressImages({ directory, silent: true, concurrency: 1 })

    const metadata = await sharp(imagePath).metadata()
    const after = await sharp(imagePath).ensureAlpha().raw({ depth: 'ushort' }).toBuffer()
    assert.equal(metadata.bitsPerSample, 16)
    assert.equal(metadata.depth, 'ushort')
    assert.deepEqual(after, before)
  })

  it('detects palette-safe truecolor PNGs without quantizing their pixels', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'two-color.png')
    const width = 256
    const height = 256
    const pixels = Buffer.alloc(width * height * 3)
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 3
      const value = index % 2 === 0 ? 0 : 255
      pixels[offset] = value
      pixels[offset + 1] = 64
      pixels[offset + 2] = 255 - value
    }
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0, palette: false })
      .toFile(imagePath)
    const before = await decodedPixels(imagePath)

    const result = await compressImages({ directory, silent: true, concurrency: 1 })

    const metadata = await sharp(imagePath).metadata()
    assert.equal(result.compressedFiles, 1)
    assert.equal(metadata.isPalette, true)
    assert.deepEqual(await decodedPixels(imagePath), before)
  })

  it('preserves the displayed orientation of EXIF-rotated JPEGs', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'oriented.jpg')
    await createGradientJpeg(imagePath, 95, 6)
    const before = await sharp(imagePath).autoOrient().raw().toBuffer({ resolveWithObject: true })

    await compressImages({ directory, silent: true, concurrency: 1 })

    const after = await sharp(imagePath).autoOrient().raw().toBuffer({ resolveWithObject: true })
    assert.equal(after.info.width, before.info.width)
    assert.equal(after.info.height, before.info.height)
  })

  it('rejects JPEG candidates that damage full-resolution high-frequency detail', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'high-frequency.jpg')
    await createNoiseImage(imagePath, 'jpeg', 1024, 768)
    const before = await sharp(imagePath).autoOrient().removeAlpha().raw().toBuffer()

    await compressImages({ directory, silent: true, concurrency: 1 })

    const after = await sharp(imagePath).autoOrient().removeAlpha().raw().toBuffer()
    assert.equal(after.length, before.length)
    let absoluteError = 0
    let squaredError = 0
    for (let index = 0; index < before.length; index += 1) {
      const error = Math.abs(before[index] - after[index])
      absoluteError += error
      squaredError += error * error
    }
    const meanAbsoluteError = absoluteError / before.length
    const meanSquaredError = squaredError / before.length
    const psnr =
      meanSquaredError === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(65025 / meanSquaredError)

    assert.ok(meanAbsoluteError <= 3, `MAE ${meanAbsoluteError.toFixed(2)} exceeds 3`)
    assert.ok(psnr >= 40, `PSNR ${psnr.toFixed(2)}dB is below 40dB`)
  })

  it('preserves animation frames, timing, and loop counts', async () => {
    const directory = await createTemporaryDirectory()
    const imagePaths = [path.join(directory, 'motion.gif'), path.join(directory, 'motion.webp')]
    await Promise.all([
      createAnimatedImage(imagePaths[0], 'gif'),
      createAnimatedImage(imagePaths[1], 'webp')
    ])
    const before = await Promise.all(
      imagePaths.map(async (filePath) => ({
        metadata: await sharp(filePath, { animated: true }).metadata(),
        pixels: await decodedAnimatedPixels(filePath)
      }))
    )

    await compressImages({ directory, silent: true })

    for (let index = 0; index < imagePaths.length; index += 1) {
      const metadata = await sharp(imagePaths[index], { animated: true }).metadata()
      assert.equal(metadata.pages, before[index].metadata.pages)
      assert.equal(metadata.loop, before[index].metadata.loop)
      assert.deepEqual(metadata.delay, before[index].metadata.delay)
      assert.deepEqual(await decodedAnimatedPixels(imagePaths[index]), before[index].pixels)
    }
  })

  it('reports corrupt images and removes all temporary candidates', async () => {
    const directory = await createTemporaryDirectory()
    await writeFile(path.join(directory, 'broken.png'), 'not an image')

    const result = await compressImages({ directory, silent: true })

    assert.equal(result.failedFiles, 1)
    assert.equal(result.totalFiles, 1)
    assert.deepEqual(await readdir(directory), ['broken.png'])
  })

  it('validates concurrency before starting work', async () => {
    const directory = await createTemporaryDirectory()
    await assert.rejects(
      compressImages({ directory, silent: true, concurrency: 0 }),
      /concurrency/
    )
  })

  it('emits ANSI colors when explicitly enabled', async () => {
    const directory = await createTemporaryDirectory()
    const originalWrite = process.stdout.write
    const messages: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      messages.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await compressImages({ directory, color: true })
      assert.ok(messages.join('\n').includes(String.fromCharCode(27)))
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('throws for a missing directory without logging in silent mode', async () => {
    const directory = path.join(await createTemporaryDirectory(), 'missing')
    const originalError = console.error
    const messages: unknown[][] = []
    console.error = (...args: unknown[]) => messages.push(args)

    try {
      await assert.rejects(compressImages({ directory, silent: true }), /目录不存在/)
      assert.deepEqual(messages, [])
    } finally {
      console.error = originalError
    }
  })
})
