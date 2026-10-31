/**
 * 市场时区与「当天」判定。
 *
 * 交易所时区真源：后端 src/platform/marketdata/models.py::MARKETS。
 * 注意 scripts/check-timezones.mjs 的两条约束：
 *   1) Intl 的 timeZone 必须传变量，不能写字面量；
 *   2) 不要对时间字符串做 slice/substring，统一走 Date 解析。
 */

const MARKET_TIME_ZONE: Record<string, string> = {
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  US: 'America/New_York',
}

/** 市场码 → IANA 时区；未知市场回退 CN（与前端 market 默认 'CN' 一致）。 */
export function marketTimeZone(market?: string | null): string {
  const key = String(market || 'CN').trim().toUpperCase()
  return MARKET_TIME_ZONE[key] || MARKET_TIME_ZONE.CN
}

/**
 * 解析时间字符串为 Date。
 * 后端 _to_dict 会把库内 naive 时间补成带 +00:00 的 ISO；
 * 这里对「无偏移」的历史/异常值按 UTC 解释，避免浏览器按本地时区误读。
 */
export function parseInstant(value?: string | null): Date | null {
  if (!value) return null
  const text = String(value).trim()
  if (!text) return null
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  const normalized = hasOffset ? text : `${text.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 某个瞬间在指定市场时区下的 YYYY-MM-DD。 */
export function marketDateKey(
  value: string | Date | null | undefined,
  market?: string | null,
): string {
  const date = value instanceof Date ? value : parseInstant(value)
  if (!date) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: marketTimeZone(market),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const pick = (type: string) => parts.find((item) => item.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/** 该时间是否落在「市场当天」（按交易所时区，与浏览器所在时区无关）。 */
export function isSameMarketDay(
  value?: string | null,
  market?: string | null,
  now: Date = new Date(),
): boolean {
  const target = marketDateKey(value, market)
  return !!target && target === marketDateKey(now, market)
}
