# 图片批量压缩工具 (Image Batch Compressor)

一个高效、智能的图片批量压缩工具，支持递归处理目录中的所有图片文件，采用智能压缩策略，在保持图片质量的同时最大化减小文件体积。

## ✨ 特性

- 🚀 **批量处理** - 递归扫描并压缩指定目录下的所有图片
- 📁 **多格式支持** - 支持 JPG、PNG、WebP、GIF、AVIF 等主流格式
- 🧠 **智能压缩** - 根据不同格式和图片特性自动选择最佳压缩策略
- 📊 **详细统计** - 实时显示压缩进度和最终统计结果
- 🔧 **灵活使用** - 支持命令行工具和 Node.js API 两种使用方式
- 🔇 **静默模式** - 可选择关闭日志输出，适合集成到自动化流程
- ⚡ **高性能** - 基于 Sharp 图像处理库，处理速度快

## 📦 安装

### 全局安装（推荐用于命令行使用）

```bash
npm install -g q-image-compressor
# 或
yarn global add q-image-compressor
```

### 项目依赖安装

```bash
npm install q-image-compressor
# 或
yarn add q-image-compressor
```

## 🚀 使用方法

### 命令行使用

```bash
# 压缩 public 目录下的所有图片
image-compress --dir=public

# 或使用简写
image-compress -dir=public

# 支持的参数格式
image-compress --dir public
image-compress -dir public
```

### Node.js API 使用

```javascript
import { compressImages } from 'q-image-compressor'

// 基本使用
const result = await compressImages({
  directory: 'public'
})

// 静默模式（不输出日志）
const result = await compressImages({
  directory: 'public',
  silent: true
})

// 处理结果
console.log(`压缩完成！节省了 ${result.savedPercentage.toFixed(1)}% 的空间`)
```

## 📖 API 文档

### compressImages(options)

压缩指定目录下的所有图片文件。

#### 参数

- `options` (CompressionOptions) - 压缩配置对象
  - `directory` (string, 必需) - 要处理的目录路径，支持相对路径和绝对路径
  - `silent` (boolean, 可选) - 是否开启静默模式，默认为 `false`

#### 返回值

返回一个 Promise，resolve 时返回 `CompressionResult` 对象：

```typescript
interface CompressionResult {
  totalFiles: number        // 扫描到的图片文件总数
  compressedFiles: number   // 成功压缩的文件数
  skippedFiles: number      // 跳过的文件数（已优化或太小）
  failedFiles: number       // 处理失败的文件数
  totalOriginalSize: number // 原始总大小（MB）
  totalCompressedSize: number // 压缩后总大小（MB）
  savedSize: number         // 节省的空间（MB）
  savedPercentage: number   // 节省的百分比
  timeTaken: number         // 处理用时（秒）
}
```

## 🎯 压缩策略

本工具针对不同格式采用了优化的压缩策略：

### JPEG/JPG
- 质量设置为 80%
- 启用渐进式扫描
- 使用 mozjpeg 编码器获得更好的压缩效果

### PNG
- 智能判断是否包含透明通道
- 无透明度的 PNG 会尝试转换为 JPEG（如果文件更小）
- 有透明度的 PNG 使用最高压缩级别（9）
- 启用调色板优化

### WebP
- 质量设置为 80%
- 启用智能子采样
- 非无损压缩模式

### GIF
- 静态 GIF 自动转换为 WebP
- 动画 GIF 保持原格式（避免丢失动画）

### AVIF
- 质量设置为 75%
- 非无损压缩模式

### 智能跳过
- 小于 50KB 的文件自动跳过
- 压缩后体积减少不足 5% 的保持原文件

## 📋 示例输出

```
🚀 开始优化图片... (目录: public)

📁 public/
  ✅ hero-bg.jpg - 2.45MB → 0.98MB (节省 60.0%)
  ✅ logo.png - 156KB → 89KB (节省 42.9%)
  ⏭️  favicon.ico - 12KB (已经很小，跳过)

  📁 public/images/
    ✅ banner.webp - 1.23MB → 0.67MB (节省 45.5%)
    ⏭️  icon.gif - 234KB (动画GIF，跳过)

────────────────────────────────────────────────
📊 优化结果汇总

  扫描文件: 5 个
  优化成功: 3 个
  跳过文件: 2 个
  处理失败: 0 个

  原始大小: 4.07MB
  优化后: 1.74MB
  节省空间: 2.33MB (57.2%)

  用时: 3.2秒
────────────────────────────────────────────────
```

## 🛠️ 开发

### 克隆项目

```bash
git clone https://github.com/xuqssq/image-compress.git
cd q-image-compressor
```

### 安装依赖

```bash
yarn install
```

### 构建项目

```bash
yarn build
```

### 本地测试

```bash
# 测试命令行工具
yarn start --dir=test-images

```

## 🤝 贡献

欢迎提交 Pull Request 或创建 Issue！

1. Fork 本仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 🙏 致谢

- [Sharp](https://github.com/lovell/sharp) - 高性能的 Node.js 图像处理库
- 所有贡献者和使用者

## 📮 联系方式

- 作者：[你的名字]
- 邮箱：[xuqssq@gmail.com]
- GitHub：[@Qian](https://github.com/xuqssq)

---

如果这个工具对你有帮助，欢迎给个 ⭐！