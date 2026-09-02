import path from 'node:path'
import { Chalk, supportsColor, type ChalkInstance } from 'chalk'
import { createConsola, type ConsolaInstance } from 'consola'
import type { CompressionResult, FileCompressionResult } from './types'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

export class Logger {
  private readonly logger: ConsolaInstance
  private readonly style: ChalkInstance

  constructor(silent: boolean, color?: boolean) {
    const useColor = color ?? Boolean(supportsColor)
    this.style = new Chalk({ level: useColor ? 3 : 0 })
    this.logger = createConsola({
      level: silent ? -999 : 3,
      fancy: true,
      formatOptions: { colors: useColor, compact: true, date: false }
    })
  }

  start(directory: string): void {
    this.logger.start(`开始优化图片 ${this.style.dim(directory)}`)
  }

  file(baseDirectory: string, result: FileCompressionResult): void {
    const relativePath = path.relative(baseDirectory, result.filePath) || path.basename(result.filePath)

    if (result.status === 'compressed') {
      const savedPercentage =
        ((result.originalBytes - result.finalBytes) / result.originalBytes) * 100
      this.logger.success(
        `${relativePath}  ${this.style.dim(`${formatBytes(result.originalBytes)} → ${formatBytes(result.finalBytes)}`)}  ${this.style.green(`-${savedPercentage.toFixed(1)}%`)}`
      )
      return
    }

    if (result.status === 'skipped') {
      this.logger.log(
        this.style.yellow(
          `• ${relativePath}  ${formatBytes(result.originalBytes)}  ${result.reason ?? '无需替换'}`
        )
      )
      return
    }

    this.logger.error(`${relativePath}: ${result.reason ?? '压缩失败'}`)
  }

  summary(result: CompressionResult): void {
    const separator = '─'.repeat(60)
    this.logger.log(this.style.dim(separator))
    this.logger.info(this.style.bold('优化结果汇总'))
    this.logger.log(`扫描文件  ${result.totalFiles}`)
    this.logger.success(`优化成功  ${result.compressedFiles}`)
    this.logger.log(this.style.yellow(`跳过文件  ${result.skippedFiles}`))
    if (result.failedFiles > 0) this.logger.error(`处理失败  ${result.failedFiles}`)
    else this.logger.log('处理失败  0')
    this.logger.log(`原始大小  ${formatBytes(result.totalOriginalSize * 1024 * 1024)}`)
    this.logger.log(`优化后    ${formatBytes(result.totalCompressedSize * 1024 * 1024)}`)
    this.logger.success(
      `节省空间  ${formatBytes(result.savedSize * 1024 * 1024)} (${result.savedPercentage.toFixed(1)}%)`
    )
    this.logger.log(`用时      ${result.timeTaken.toFixed(2)}秒`)
    this.logger.log(this.style.dim(separator))
  }

  fatal(message: string): void {
    this.logger.error(message)
  }
}
