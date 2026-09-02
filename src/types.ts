export interface CompressionResult {
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

export interface CompressionOptions {
  directory: string
  silent?: boolean
  color?: boolean
  concurrency?: number
  profile?: 'max' | 'balanced'
}

export type FileStatus = 'compressed' | 'skipped' | 'failed'

export interface FileCompressionResult {
  filePath: string
  status: FileStatus
  originalBytes: number
  finalBytes: number
  reason?: string
}
