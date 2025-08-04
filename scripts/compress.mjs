#!/usr/bin/env node
import { compressImages } from '../dist/index.cjs'

// 解析命令行参数
function getDirectoryFromArgs() {
  const args = process.argv.slice(2)
  let directory = null

  for (const arg of args) {
    // 支持 --dir=public 或 -dir=public 格式
    if (arg.startsWith('--dir=') || arg.startsWith('-dir=')) {
      directory = arg.split('=')[1]
      break
    }
    // 也支持 --dir public 或 -dir public 格式
    const index = args.indexOf(arg)
    if ((arg === '--dir' || arg === '-dir') && args[index + 1]) {
      directory = args[index + 1]
      break
    }
  }

  return directory
}

// 命令行入口函数
async function cli() {
  const directory = getDirectoryFromArgs()

  if (!directory) {
    console.error('\n❌ 错误：请指定要优化的图片目录\n')
    console.error('使用方法:')
    console.error('  yarn start -dir=public')
    console.error('  yarn start --dir=public')
    console.error('  yarn start -dir public')
    console.error('  yarn start --dir public\n')
    process.exit(1)
  }

  try {
    await compressImages({ directory })
  } catch (err) {
    process.exit(1)
  }
}

// 执行命令行
cli().catch(console.error)
