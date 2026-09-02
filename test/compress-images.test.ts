import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { afterEach, describe, it } from 'node:test'
import path from 'node:path'
import { compressImages } from '../src/index'
import {
  cleanupTemporaryDirectories,
  createImage,
  createTemporaryDirectory,
  createUnsupportedFile,
  fileBytes,
  metadata
} from './helpers'

const QUALITY_ENV = 'Q_IMAGE_COMPRESSOR_MAX_QUALITY'
const QUALITY_ENV_ALIAS = 'MAX_QUALITY'

afterEach(async () => {
  delete process.env[QUALITY_ENV]
  delete process.env[QUALITY_ENV_ALIAS]
  await cleanupTemporaryDirectories()
})

describe('compressImages', () => {
  it('recursively processes supported images and returns consistent statistics', async () => {
    const directory = await createTemporaryDirectory()
    await Promise.all([
      createImage(path.join(directory, 'root.jpg'), 'jpeg'),
      createImage(path.join(directory, 'nested', 'child.png'), 'png')
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
  })

  it('preserves JPEG, PNG, WebP, and AVIF encoded formats', async () => {
    const directory = await createTemporaryDirectory()
    const fixtures = [
      ['image.jpg', 'jpeg'],
      ['image.png', 'png'],
      ['image.webp', 'webp'],
      ['image.avif', 'avif']
    ] as const
    await Promise.all(
      fixtures.map(([name, format]) => createImage(path.join(directory, name), format, 160, 120))
    )

    await compressImages({ directory, silent: true, concurrency: 2 })

    for (const [name, format] of fixtures) {
      assert.equal((await metadata(path.join(directory, name))).format, format)
    }
  })

  it('handles BMP, ICO, TIFF, and PNM without changing their format', async () => {
    const directory = await createTemporaryDirectory()
    const fixtures = [
      ['image.bmp', 'bmp'],
      ['image.ico', 'ico'],
      ['image.tiff', 'tiff'],
      ['image.pnm', 'pnm']
    ] as const
    await Promise.all(
      fixtures.map(([name, format]) => createImage(path.join(directory, name), format, 64, 48))
    )

    const result = await compressImages({ directory, silent: true, concurrency: 2 })

    assert.equal(result.totalFiles, fixtures.length)
    assert.equal(result.failedFiles, 0)
    for (const [name, format] of fixtures) {
      assert.equal((await metadata(path.join(directory, name))).format, format)
    }
  })

  it('recognizes formats that cannot be re-encoded and leaves them untouched', async () => {
    const directory = await createTemporaryDirectory()
    const files = ['animation.gif', 'texture.dds', 'scene.exr', 'vector.svg']
    await Promise.all(files.map((name) => createUnsupportedFile(path.join(directory, name))))
    const before = await Promise.all(files.map((name) => fileBytes(path.join(directory, name))))

    const result = await compressImages({ directory, silent: true })

    assert.equal(result.totalFiles, files.length)
    assert.equal(result.skippedFiles, files.length)
    assert.equal(result.failedFiles, 0)
    const after = await Promise.all(files.map((name) => fileBytes(path.join(directory, name))))
    assert.deepEqual(after, before)
  })

  it('uses maxQuality 75 by default and accepts the canonical environment override', async () => {
    const defaultDirectory = await createTemporaryDirectory()
    const highDirectory = await createTemporaryDirectory()
    await Promise.all([
      createImage(path.join(defaultDirectory, 'photo.jpg'), 'jpeg', 640, 400, 100),
      createImage(path.join(highDirectory, 'photo.jpg'), 'jpeg', 640, 400, 100)
    ])

    await compressImages({ directory: defaultDirectory, silent: true })
    process.env[QUALITY_ENV] = '95'
    await compressImages({ directory: highDirectory, silent: true })

    const defaultSize = (await fileBytes(path.join(defaultDirectory, 'photo.jpg'))).length
    const highSize = (await fileBytes(path.join(highDirectory, 'photo.jpg'))).length
    assert.ok(defaultSize < highSize)
  })

  it('supports MAX_QUALITY as an environment alias', async () => {
    const directory = await createTemporaryDirectory()
    await createImage(path.join(directory, 'photo.jpg'), 'jpeg', 320, 240, 100)
    process.env[QUALITY_ENV_ALIAS] = '80'

    const result = await compressImages({ directory, silent: true })

    assert.equal(result.totalFiles, 1)
    assert.equal(result.failedFiles, 0)
  })

  it('rejects an invalid maxQuality before modifying files', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'photo.jpg')
    await createImage(imagePath, 'jpeg')
    const before = await fileBytes(imagePath)
    process.env[QUALITY_ENV] = '101'

    await assert.rejects(compressImages({ directory, silent: true }), /MAX_QUALITY/)
    assert.deepEqual(await fileBytes(imagePath), before)
  })

  it('never replaces an image with a larger file', async () => {
    const directory = await createTemporaryDirectory()
    const imagePath = path.join(directory, 'small.png')
    await createImage(imagePath, 'png', 2, 2)
    const before = await fileBytes(imagePath)

    await compressImages({ directory, silent: true })

    assert.ok((await fileBytes(imagePath)).length <= before.length)
  })

  it('keeps concurrent invocations isolated', async () => {
    const firstDirectory = await createTemporaryDirectory()
    const secondDirectory = await createTemporaryDirectory()
    await Promise.all([
      createImage(path.join(firstDirectory, 'first.jpg'), 'jpeg'),
      createImage(path.join(secondDirectory, 'second.png'), 'png')
    ])

    const [first, second] = await Promise.all([
      compressImages({ directory: firstDirectory, silent: true }),
      compressImages({ directory: secondDirectory, silent: true })
    ])

    assert.equal(first.totalFiles, 1)
    assert.equal(second.totalFiles, 1)
  })

  it('reports corrupt images and removes temporary files', async () => {
    const directory = await createTemporaryDirectory()
    await writeFile(path.join(directory, 'broken.png'), 'not an image')

    const result = await compressImages({ directory, silent: true })

    assert.equal(result.failedFiles, 1)
    assert.deepEqual(await readdir(directory), ['broken.png'])
  })

  it('validates concurrency and profile', async () => {
    const directory = await createTemporaryDirectory()
    await assert.rejects(
      compressImages({ directory, silent: true, concurrency: 0 }),
      /concurrency/
    )
    await assert.rejects(
      compressImages({ directory, silent: true, profile: 'invalid' as 'max' }),
      /profile/
    )
  })

  it('emits colors when explicitly enabled', async () => {
    const directory = await createTemporaryDirectory()
    const originalWrite = process.stdout.write
    const messages: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      messages.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      await compressImages({ directory, color: true })
      assert.ok(messages.join('').includes(String.fromCharCode(27)))
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
