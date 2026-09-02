const DEFAULT_MAX_QUALITY = 75
const QUALITY_ENV = 'Q_IMAGE_COMPRESSOR_MAX_QUALITY'
const QUALITY_ENV_ALIAS = 'MAX_QUALITY'

export function resolveMaxQuality(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env[QUALITY_ENV] ?? env[QUALITY_ENV_ALIAS]
  if (rawValue === undefined || rawValue === '') return DEFAULT_MAX_QUALITY

  if (!/^\d+$/.test(rawValue)) {
    throw new TypeError(`${QUALITY_ENV} / ${QUALITY_ENV_ALIAS} 必须是 1 到 100 的整数`)
  }

  const quality = Number(rawValue)
  if (quality < 1 || quality > 100) {
    throw new RangeError(`${QUALITY_ENV} / ${QUALITY_ENV_ALIAS} 必须在 1 到 100 之间`)
  }

  return quality
}
