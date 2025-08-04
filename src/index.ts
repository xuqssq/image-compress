import sharp from 'sharp'
import path from 'path'
import fs from 'fs'

// 压缩结果接口
interface CompressionResult {
  totalFiles: number
  compressedFiles: number
  skippedFiles: number
  failedFiles: number
  totalOriginalSize: number
  totalCompressedSize: number
  savedSize: number
  savedPercentage: number
  timeTaken: number
}

// 压缩配置接口
interface CompressionOptions {
  directory: string
  silent?: boolean  // 是否静默模式（不输出日志）
}

// 支持的图片格式
const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']

// 压缩统计
let totalFiles = 0
let compressedFiles = 0
let skippedFiles = 0
let totalOriginalSize = 0
let totalCompressedSize = 0
let isSilent = false

// 日志输出函数（支持静默模式）
function log(...args: any[]) {
  if (!isSilent) {
    console.log(...args)
  }
}

function error(...args: any[]) {
  if (!isSilent) {
    console.error(...args)
  }
}

// 获取文件大小（MB）
function getFileSizeInMB(filePath: string) {
  const stats = fs.statSync(filePath)
  return stats.size / (1024 * 1024)
}

// 获取文件大小的友好显示
function formatFileSize(sizeInMB: number) {
  if (sizeInMB < 1) {
    return `${(sizeInMB * 1024).toFixed(0)}KB`
  }
  return `${sizeInMB.toFixed(2)}MB`
}

// 重置统计数据
function resetStats() {
  totalFiles = 0
  compressedFiles = 0
  skippedFiles = 0
  totalOriginalSize = 0
  totalCompressedSize = 0
}

// 压缩单个图片
async function compressImage(inputPath: string, indent = '') {
  const ext = path.extname(inputPath).toLowerCase()
  const originalSize = getFileSizeInMB(inputPath)
  const tempPath = inputPath + '.tmp'

  totalFiles++
  totalOriginalSize += originalSize

  // 跳过已经很小的图片（小于50KB）
  if (originalSize < 0.05) {
    skippedFiles++
    totalCompressedSize += originalSize
    log(
      `${indent}⏭️  ${path.basename(inputPath)} - ${formatFileSize(originalSize)} (已经很小，跳过)`
    )
    return
  }

  try {
    let sharpInstance = sharp(inputPath)
    const metadata = await sharpInstance.metadata()

    // 根据不同格式采用不同的压缩策略
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        await sharpInstance
          .jpeg({
            quality: 80,
            progressive: true,
            mozjpeg: true,
            force: true
          })
          .toFile(tempPath)
        break

      case '.png':
        // 对于PNG，先尝试转换为JPEG（如果不需要透明度）
        if (!metadata.hasAlpha) {
          await sharpInstance
            .jpeg({
              quality: 85,
              progressive: true,
              mozjpeg: true
            })
            .toFile(tempPath.replace('.tmp', '.jpg.tmp'))

          // 比较大小，选择更小的
          if (fs.existsSync(tempPath.replace('.tmp', '.jpg.tmp'))) {
            const jpegSize = getFileSizeInMB(tempPath.replace('.tmp', '.jpg.tmp'))
            if (jpegSize < originalSize * 0.8) {
              fs.renameSync(tempPath.replace('.tmp', '.jpg.tmp'), tempPath)
            } else {
              fs.unlinkSync(tempPath.replace('.tmp', '.jpg.tmp'))
              // 使用PNG压缩
              await sharpInstance
                .png({
                  quality: 85,
                  compressionLevel: 9,
                  palette: true,
                  effort: 10
                })
                .toFile(tempPath)
            }
          }
        } else {
          // 有透明度，使用PNG压缩
          await sharpInstance
            .png({
              quality: 85,
              compressionLevel: 9,
              palette: true,
              effort: 10
            })
            .toFile(tempPath)
        }
        break

      case '.webp':
        await sharpInstance
          .webp({
            quality: 80,
            effort: 6,
            lossless: false,
            nearLossless: false,
            smartSubsample: true
          })
          .toFile(tempPath)
        break

      case '.gif':
        // 静态GIF转换为WebP
        if (!metadata.pages || metadata.pages === 1) {
          await sharpInstance
            .webp({
              quality: 85,
              effort: 6
            })
            .toFile(tempPath.replace('.gif', '.webp'))

          if (fs.existsSync(tempPath.replace('.gif', '.webp'))) {
            fs.renameSync(tempPath.replace('.gif', '.webp'), tempPath)
          }
        } else {
          // 动画GIF保持原样
          skippedFiles++
          totalCompressedSize += originalSize
          log(
            `${indent}⏭️  ${path.basename(inputPath)} - ${formatFileSize(
              originalSize
            )} (动画GIF，跳过)`
          )
          return
        }
        break

      case '.avif':
        await sharpInstance
          .avif({
            quality: 75,
            effort: 6,
            lossless: false
          })
          .toFile(tempPath)
        break
    }

    // 检查压缩结果
    if (fs.existsSync(tempPath)) {
      const compressedSize = getFileSizeInMB(tempPath)

      // 只有当压缩后文件更小时才替换
      if (compressedSize < originalSize * 0.95) {
        // 至少减少5%
        fs.renameSync(tempPath, inputPath)
        const savedSize = originalSize - compressedSize
        const savedPercentage = ((savedSize / originalSize) * 100).toFixed(1)

        totalCompressedSize += compressedSize
        compressedFiles++

        log(
          `${indent}✅ ${path.basename(inputPath)} - ${formatFileSize(
            originalSize
          )} → ${formatFileSize(compressedSize)} (节省 ${savedPercentage}%)`
        )
      } else {
        // 压缩效果不好，保持原文件
        fs.unlinkSync(tempPath)
        totalCompressedSize += originalSize
        skippedFiles++
        log(
          `${indent}⏭️  ${path.basename(inputPath)} - ${formatFileSize(
            originalSize
          )} (已优化，跳过)`
        )
      }
    }
  } catch (err: any) {
    // 清理临时文件
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath)
    }
    totalCompressedSize += originalSize
    error(`${indent}❌ ${path.basename(inputPath)} - 压缩失败: ${err.message}`)
  }
}

// 递归处理目录
async function processDirectory(dirPath: string, baseDir: string, depth = 0) {
  const files = fs.readdirSync(dirPath)
  const currentIndent = '  '.repeat(depth)
  const fileIndent = '  '.repeat(depth + 1)

  // 获取相对路径用于显示
  const relativePath = path.relative(baseDir, dirPath)

  // 只在非根目录时显示目录名
  if (depth > 0) {
    log(`${currentIndent}📁 ${relativePath || path.basename(baseDir)}/`)
  }

  // 先处理文件
  const imageFiles: string[] = []
  const subdirs: string[] = []

  for (const file of files) {
    const filePath = path.join(dirPath, file)
    const stat = fs.statSync(filePath)

    if (stat.isDirectory()) {
      subdirs.push(file)
    } else if (stat.isFile()) {
      const ext = path.extname(file).toLowerCase()
      if (imageExtensions.includes(ext)) {
        imageFiles.push(filePath)
      }
    }
  }

  // 处理图片文件
  for (const filePath of imageFiles) {
    await compressImage(filePath, fileIndent)
  }

  // 处理子目录
  for (const subdir of subdirs) {
    const subdirPath = path.join(dirPath, subdir)
    // 如果当前目录有文件或下一个目录有内容，添加空行
    if (imageFiles.length > 0 || depth === 0) {
      log('')
    }
    await processDirectory(subdirPath, baseDir, depth + 1)
  }
}

// 主函数 - 导出供外部使用
async function compressImages(options: CompressionOptions): Promise<CompressionResult> {
  const { directory, silent = false } = options
  isSilent = silent
  
  // 重置统计数据
  resetStats()
  
  const imagesDir = path.isAbsolute(directory) 
    ? directory 
    : path.join(process.cwd(), directory)
  
  log(`🚀 开始优化图片... (目录: ${directory})\n`)

  // 检查目录是否存在
  if (!fs.existsSync(imagesDir)) {
    const errorMsg = `目录不存在: ${imagesDir}`
    error(`\n❌ 错误：${errorMsg}`)
    error(`   请确认目录路径是否正确\n`)
    throw new Error(errorMsg)
  }

  const startTime = Date.now()

  try {
    log(`📁 ${path.basename(directory)}/`)
    await processDirectory(imagesDir, imagesDir, 0)

    const endTime = Date.now()
    const timeTaken = ((endTime - startTime) / 1000)
    const savedSize = totalOriginalSize - totalCompressedSize
    const savedPercentage = totalOriginalSize > 0 
      ? ((savedSize / totalOriginalSize) * 100) 
      : 0

    log('\n' + '─'.repeat(60))
    log('📊 优化结果汇总\n')
    log(`  扫描文件: ${totalFiles} 个`)
    log(`  优化成功: ${compressedFiles} 个`)
    log(`  跳过文件: ${skippedFiles} 个`)
    log(`  处理失败: ${totalFiles - compressedFiles - skippedFiles} 个\n`)
    log(`  原始大小: ${formatFileSize(totalOriginalSize)}`)
    log(`  优化后: ${formatFileSize(totalCompressedSize)}`)
    log(
      `  节省空间: ${formatFileSize(savedSize)} (${savedPercentage.toFixed(1)}%)\n`
    )
    log(`  用时: ${timeTaken.toFixed(1)}秒`)
    log('─'.repeat(60))

    return {
      totalFiles,
      compressedFiles,
      skippedFiles,
      failedFiles: totalFiles - compressedFiles - skippedFiles,
      totalOriginalSize,
      totalCompressedSize,
      savedSize,
      savedPercentage,
      timeTaken
    }
  } catch (err) {
    error('❌ 处理过程中出错:', err)
    throw err
  }
}

// 导出
export { 
  compressImages, 
  compressImages as default, 
  CompressionResult, 
  CompressionOptions 
}
