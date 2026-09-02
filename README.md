# q-image-compressor

一个目录图片压缩工具。递归扫描所有子目录，保持文件扩展名和编码格式，只在输出严格小于原文件时执行原子替换。

## 特性

- 单一图像运行时：生产代码不依赖 Sharp。
- JPEG、PNG、WebP、AVIF 和 HEIC 使用可配置的有损质量。
- PNG 同时比较 Oxipng 无损优化和调色板量化结果。
- BMP、ICO、TIFF、PNM 等格式尝试同格式重编码。
- 使用 Consola 和 Chalk 输出分级彩色日志。
- 支持文件并发与像素内存预算。
- 单张图片失败不会中断整个目录。
- 临时文件与原图位于同一目录，通过原子 rename 替换。

## 安装

```bash
npm install --global q-image-compressor
```

也可以安装到项目：

```bash
npm install --save-dev q-image-compressor
```

要求 Node.js 18.17 或更高版本。

## 使用

```bash
q-image-compressor --dir public

# 原有参数格式继续支持
q-image-compressor -dir=public
q-image-compressor --dir=public
q-image-compressor -dir public
q-image-compressor --dir public
```

包同时提供 `q-image-compressor` 和 `image-compress` 两个命令。

### 质量

质量由环境变量控制，默认值为 75：

```bash
Q_IMAGE_COMPRESSOR_MAX_QUALITY=75 q-image-compressor --dir public
```

也支持简写环境变量：

```bash
MAX_QUALITY=75 q-image-compressor --dir public
```

`Q_IMAGE_COMPRESSOR_MAX_QUALITY` 优先级更高。取值必须是 1 到 100 的整数：

- 数值越低，通常文件越小，但失真风险越高。
- 数值越高，细节保留越多，但文件更大。
- 默认 75 是体积和观感之间的偏压缩取向。

该值用于 JPEG、PNG 量化、WebP、AVIF 和 HEIC。PNG 的 Oxipng 无损候选不受质量值影响。

### 完整选项

```text
-d, -dir, --dir <目录>    要递归处理的图片目录
-s, --silent              关闭所有日志
    --no-color            关闭颜色输出
    --concurrency <数量>  文件并发数，默认最多 4
    --profile <档位>      max（默认）或 balanced
-h, --help                显示帮助
```

- `max` 使用更慢的 PNG/AVIF 编码配置，优先最小体积。
- `balanced` 降低编码器计算量，适合开发和持续集成。

## 格式支持

| 格式 | 行为 |
| --- | --- |
| JPEG/JPG/JPE/JFIF | MozJPEG scan optimization，使用环境变量质量；EXIF Orientation 会先旋转到正确显示方向 |
| PNG | 比较 Oxipng 无损结果和 `pngQuantize` 有损结果，选择最小候选 |
| WebP | 使用环境变量质量同格式重编码；运行平台无法解码时保留源文件并报告失败 |
| AVIF | 使用环境变量质量、YUV 4:2:0 同格式重编码 |
| HEIC/HEIF | macOS 和 Windows 使用系统 HEVC 编码器；Linux 或缺少系统编解码器时报告失败 |
| BMP | 同格式重编码 |
| ICO | 同格式重编码 |
| TIFF/TIF | 同格式重编码 |
| PNM/PBM/PGM/PPM/PAM | 以 PNM 家族格式重编码 |
| TGA | 尝试同格式重编码；运行时无法重新识别输出时保留原文件 |
| farbfeld/FF | 尝试同格式重编码；编码器不可用时保留原文件 |
| GIF |  不支持，明确跳过 |
| DDS | 只能解码、不能同格式编码，明确跳过 |
| OpenEXR | 只能解码、不能同格式编码，明确跳过 |
| SVG/SVGZ | 只能解码、不能同格式编码，明确跳过 |

WebP、AVIF 等输入支持会受到当前平台二进制能力影响。任何编码或回读验证失败都不会覆盖源文件。

## Node.js API

```ts
import { compressImages } from 'q-image-compressor'

const result = await compressImages({
  directory: 'public',
  silent: false,
  color: true,
  concurrency: 4,
  profile: 'max'
})

console.log(result)
```

质量仍通过进程环境变量设置：

```ts
process.env.Q_IMAGE_COMPRESSOR_MAX_QUALITY = '75'
```

### CompressionOptions

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `directory` | `string` | 必填 | 图片目录；相对路径基于当前工作目录 |
| `silent` | `boolean` | `false` | 关闭所有日志 |
| `color` | `boolean` | 自动检测 | 强制启用或关闭颜色 |
| `concurrency` | `number` | `min(CPU, 4)` | 文件并发数，范围 1 到 16 |
| `profile` | `'max' \| 'balanced'` | `'max'` | 压缩体积或速度优先 |

### CompressionResult

```ts
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
```

大小字段使用 MiB，时间使用秒。

## 开发

```bash
yarn install
yarn test
yarn typecheck
yarn lint
yarn build
```

发布前脚本会依次执行测试、类型检查、lint 和构建。

## License

MIT
