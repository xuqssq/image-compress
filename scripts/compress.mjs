#!/usr/bin/env node
/* eslint-env node */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Chalk, supportsColorStderr } from 'chalk'
import { createConsola } from 'consola'

function readValue(args, index, argument) {
  const separator = argument.indexOf('=')
  if (separator !== -1) return { value: argument.slice(separator + 1), consumed: 0 }

  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`参数 ${argument} 缺少值`)
  return { value, consumed: 1 }
}

export function parseArguments(args) {
  const options = { silent: false }
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--silent' || argument === '-s') {
      options.silent = true
      continue
    }
    if (argument === '--no-color') {
      options.color = false
      continue
    }
    if (
      argument === '--dir' ||
      argument === '-dir' ||
      argument === '-d' ||
      argument.startsWith('--dir=') ||
      argument.startsWith('-dir=') ||
      argument.startsWith('-d=')
    ) {
      const { value, consumed } = readValue(args, index, argument)
      options.directory = value
      index += consumed
      continue
    }
    if (argument === '--concurrency' || argument.startsWith('--concurrency=')) {
      const { value, consumed } = readValue(args, index, argument)
      const concurrency = Number(value)
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('--concurrency 必须是大于 0 的整数')
      }
      options.concurrency = concurrency
      index += consumed
      continue
    }
    if (argument === '--profile' || argument.startsWith('--profile=')) {
      const { value, consumed } = readValue(args, index, argument)
      if (value !== 'max' && value !== 'balanced') {
        throw new Error('--profile 必须是 max 或 balanced')
      }
      options.profile = value
      index += consumed
      continue
    }

    throw new Error(`未知参数: ${argument}`)
  }

  return { help, options }
}

export function formatHelp(color = false) {
  const style = new Chalk({ level: color ? 3 : 0 })
  const command = style.cyan('q-image-compressor')
  return [
    style.bold('图片批量压缩工具'),
    '',
    `用法: ${command} --dir <目录> [选项]`,
    '',
    '选项:',
    '  -d, -dir, --dir <目录>    要递归处理的图片目录',
    '  -s, --silent              关闭所有日志',
    '      --no-color            关闭 ANSI 彩色输出',
    '      --concurrency <数量>  并行处理的文件数（默认最多 4）',
    '      --profile <档位>      max（默认）或 balanced',
    '  -h, --help                显示帮助',
    '',
    '兼容写法:',
    `  ${command} -dir=public`,
    `  ${command} --dir=public`,
    `  ${command} -dir public`,
    `  ${command} --dir public`
  ].join('\n')
}

export async function runCli(
  args = process.argv.slice(2),
  loadCompressor = () => import('../dist/index.mjs')
) {
  const silent = args.includes('--silent') || args.includes('-s')
  const autoColor = Boolean(supportsColorStderr)
  let color = autoColor && !args.includes('--no-color')
  let logger = createConsola({ level: silent ? -999 : 3, fancy: true })

  try {
    const { help, options } = parseArguments(args)
    color = options.color ?? autoColor
    logger = createConsola({
      level: silent ? -999 : 3,
      fancy: true,
      formatOptions: { colors: color, compact: true, date: false }
    })
    if (help) {
      logger.log(formatHelp(color))
      return 0
    }
    if (!options.directory) throw new Error('请指定要优化的图片目录')

    const { compressImages } = await loadCompressor()
    await compressImages(options)
    return 0
  } catch (error) {
    if (silent) return 1
    const message = error instanceof Error ? error.message : String(error)
    logger.error(message)
    logger.log(formatHelp(color))
    return 1
  }
}

export function isDirectExecution(entryPath = process.argv[1]) {
  if (!entryPath) return false

  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectExecution()) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode
  })
}
