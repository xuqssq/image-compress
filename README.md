# q-image-compressor

递归优化目录内的 JPG、PNG、WebP、GIF 和 AVIF 图片。工具会为每张图片生成多个同格式候选，执行像素或视觉质量校验，只用体积最小且通过校验的候选原地替换源文件。

## 设计原则

- **保持真实格式**：扩展名和文件内部编码始终一致，不会把 JPEG 内容写回 `.png`。
- **质量门禁**：PNG、GIF、动画 WebP 使用源位深逐像素校验；JPEG、静态 WebP、静态 AVIF 使用标准 SSIM 和多项 RGB 误差保护栏。
- **最小合格结果**：不跳过小文件，也不设置最低节省比例；只要候选更小且通过校验就会使用。
- **安全覆盖**：候选写入源文件所在目录，校验完成后原子替换；失败时保留源文件并清理临时文件。
- **自适应搜索**：不使用固定质量档位；先确认最高质量候选可行，再通过整数二分和边界邻域复核寻找最小合格文件。
- **递归与并发**：自动遍历所有子目录，默认同时处理最多 4 个文件，并以系统内存 15%/最高 512MiB 作为在途解码预算。
- **彩色日志**：使用 Consola 管理日志级别、reporter 和 stdout/stderr，使用 Chalk 提供可强制启停的终端样式；支持 `NO_COLOR`、`--no-color` 和静默模式。

> JPEG 本身是有损格式。工具会优先探测系统中的 `jpegtran`，使用 DCT 系数级 Huffman/渐进式无损优化；没有 `jpegtran` 时自动回退，不影响正常使用。进一步的 mozjpeg 重编码必须通过保守的感知质量门禁，但仍不能描述为数学意义上的无损。PNG、GIF 和动画 WebP 则必须通过解码后像素一致性校验。

## 安装

```bash
npm install --global q-image-compressor
```

也可以安装到项目中：

```bash
npm install --save-dev q-image-compressor
```

要求 Node.js 18.17 或更高版本。

## 命令行

包同时提供 `q-image-compressor` 和 `image-compress` 两个命令名：

```bash
q-image-compressor --dir public

# 以下原有写法继续支持
q-image-compressor -dir=public
q-image-compressor --dir=public
q-image-compressor -dir public
q-image-compressor --dir public
```

完整选项：

```text
-d, -dir, --dir <目录>    要递归处理的图片目录
-s, --silent              关闭所有日志
    --no-color            关闭 ANSI 彩色输出
    --concurrency <数量>  并行处理的文件数，默认最多 4
    --profile <档位>      max（默认，最小体积）或 balanced（更快）
-h, --help                显示帮助
```

无需全局安装时可以直接运行：

```bash
npx q-image-compressor --dir public
```

## Node.js API

默认导出和具名导出均保留：

```ts
import compressImages, { type CompressionResult } from 'q-image-compressor'

const result: CompressionResult = await compressImages({
  directory: 'public',
  silent: false,
  color: true,
  concurrency: 4,
  profile: 'max'
})

console.log(`节省 ${result.savedPercentage.toFixed(1)}%`)
```

也可以使用具名导出：

```ts
import { compressImages } from 'q-image-compressor'
```

### CompressionOptions

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `directory` | `string` | 必填 | 图片目录，相对路径基于当前工作目录 |
| `silent` | `boolean` | `false` | 禁止所有普通和错误日志 |
| `color` | `boolean` | 自动检测 | 强制启用或关闭 ANSI 颜色 |
| `concurrency` | `number` | `min(CPU, 4)` | 文件并发数，范围为 1 到 16 |
| `profile` | `'max' \| 'balanced'` | `'max'` | `max` 执行完整候选搜索；`balanced` 对极高频或已极紧凑的图片启用保守剪枝并降低编码 effort |

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

大小字段继续使用 MiB，`timeTaken` 使用秒。单张图片失败不会中断整个批次，失败会计入 `failedFiles`。

## 压缩策略

| 格式 | 候选策略 | 质量保护 |
| --- | --- | --- |
| JPEG/JPG | `jpegtran` 系数级无损候选；mozjpeg 4:4:4/4:2:0 自适应质量搜索 | 标准 SSIM `>= 0.995`；全分辨率 RGB 的 PSNR `>= 40dB`、MAE `<= 3`、P99 通道误差 `<= 12`、最大通道误差 `<= 96`、锐度保留至少 98% 且增幅不超过 5% |
| PNG | 全色 PNG 的两种过滤策略；仅对适用的 8-bit 调色板图生成 palette 候选 | 按 8/16-bit 源位深解码，RGBA 逐字节一致，位深不变 |
| WebP | 无损候选；静态图进行有界自适应有损搜索，动画仅无损 | 静态图使用完整视觉门禁且 alpha 必须一致；动画逐帧一致 |
| GIF | 分别比较调色板复用/重建、最高 effort、禁止帧间误差 | 帧数、时序、循环次数和逐帧 RGBA 一致 |
| AVIF | 同位深无损候选；4:4:4/4:2:0 使用快速 effort 定位边界，再以 effort 9 最终编码和复核 | 完整视觉门禁且 alpha 必须一致；多帧输入保持原样 |

所有候选还必须满足以下条件：

1. 内部编码格式与源扩展名一致。
2. 动画帧数、帧高、延迟和循环次数一致。
3. 文件体积严格小于源文件。
4. 对应格式的像素或视觉质量门禁通过。

视觉 SSIM 由成熟的 [`ssim.js`](https://github.com/obartra/ssim) 实现，该项目是 Wang 等人 2004 年《Image Quality Assessment: From Error Visibility to Structural Similarity》算法的 JavaScript 实现。SSIM 比较最长边限制为 2048，避免超大图积分图溢出；RGB 的 PSNR、平均误差、尾部误差、最大误差、alpha 和双向锐度变化仍在全分辨率上检查，避免缩放后的单一平均指标掩盖局部或颜色失真。

有损候选会写入轻量 XMP 优化标记。后续再次运行时不会继续修改已经接受的结果，从而避免“每次单独看都合格，但多代累计后明显劣化”的代际损失。

## 开发

```bash
yarn install
yarn test
yarn typecheck
yarn lint
yarn build
```

本地运行 CLI：

```bash
yarn start --dir public
```

发布脚本会依次执行测试、类型检查、lint 和构建。`prepack` 也会重新构建，确保发布包包含最新的 ESM、CommonJS 和类型声明。

## License

MIT
