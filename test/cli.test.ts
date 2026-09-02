import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatHelp, parseArguments, runCli } from '../scripts/compress.mjs'

describe('CLI arguments', () => {
  it('preserves every documented legacy directory syntax', () => {
    const variants = [
      ['-dir=public'],
      ['--dir=public'],
      ['-dir', 'public'],
      ['--dir', 'public']
    ]

    for (const args of variants) {
      assert.equal(parseArguments(args).options.directory, 'public')
    }
  })

  it('supports operational flags without changing the required directory option', () => {
    assert.deepEqual(parseArguments(['-d', 'images', '--silent', '--no-color', '--concurrency=3', '--profile=balanced']), {
      help: false,
      options: {
        directory: 'images',
        silent: true,
        color: false,
        concurrency: 3,
        profile: 'balanced'
      }
    })
  })

  it('rejects malformed and unknown options', () => {
    assert.throws(() => parseArguments(['--dir']), /缺少值/)
    assert.throws(() => parseArguments(['--concurrency=0']), /大于 0/)
    assert.throws(() => parseArguments(['--profile=fast']), /max 或 balanced/)
    assert.throws(() => parseArguments(['--unknown']), /未知参数/)
  })

  it('provides color-capable help', () => {
    assert.match(formatHelp(false), /q-image-compressor --dir/)
    assert.ok(formatHelp(true).includes(String.fromCharCode(27)))
  })

  it('applies --no-color to CLI help', async () => {
    const originalWrite = process.stdout.write
    const messages: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      messages.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    try {
      assert.equal(await runCli(['--no-color', '--help']), 0)
      assert.ok(!messages.join('\n').includes(String.fromCharCode(27)))
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('keeps CLI failures silent when --silent is set', async () => {
    const originalError = console.error
    const messages: string[] = []
    console.error = (...args: unknown[]) => messages.push(args.join(' '))

    try {
      const exitCode = await runCli(['--silent', '--dir', 'missing'], async () => ({
        compressImages: async () => {
          throw new Error('missing directory')
        }
      }))
      assert.equal(exitCode, 1)
      assert.deepEqual(messages, [])
    } finally {
      console.error = originalError
    }
  })
})
