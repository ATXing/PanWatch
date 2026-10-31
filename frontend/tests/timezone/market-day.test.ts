import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSameMarketDay, marketDateKey, parseInstant } from '@/lib/market-time'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('market-time 市场时区当天判定', () => {
  it('CN：UTC 16:30 已是北京次日 00:30，按市场时区归到次日', () => {
    const created = '2026-10-29T16:30:00+00:00'
    expect(marketDateKey(created, 'CN')).toBe('2026-10-30')
    expect(isSameMarketDay(created, 'CN', new Date('2026-10-30T01:00:00Z'))).toBe(true)
  })

  it('CN：判定不受浏览器时区影响（TZ=UTC 下结论一致）', () => {
    vi.stubEnv('TZ', 'UTC')
    const created = '2026-10-29T16:30:00+00:00'
    expect(isSameMarketDay(created, 'CN', new Date('2026-10-30T01:00:00Z'))).toBe(true)
    expect(isSameMarketDay(created, 'CN', new Date('2026-10-30T16:30:00Z'))).toBe(false)
  })

  it('US：按纽约时区判断，跨本地日即不同天', () => {
    const created = '2026-10-30T02:00:00Z' // 纽约 10-29 22:00（EDT）
    expect(marketDateKey(created, 'US')).toBe('2026-10-29')
    expect(isSameMarketDay(created, 'US', new Date('2026-10-30T02:30:00Z'))).toBe(true)
    expect(isSameMarketDay(created, 'US', new Date('2026-10-30T05:00:00Z'))).toBe(false)
  })

  it('无偏移的历史值按 UTC 解释，不按本地时区猜', () => {
    expect(parseInstant('2026-10-30 04:08:20')?.toISOString()).toBe('2026-10-30T04:08:20.000Z')
    expect(marketDateKey('2026-10-30 04:08:20', 'CN')).toBe('2026-10-30')
  })

  it('HK 与 CN 同为 UTC+8：UTC 16:30 归到次日', () => {
    expect(marketDateKey('2026-10-30T16:30:00Z', 'HK')).toBe('2026-10-31')
    expect(marketDateKey('2026-10-30T16:30:00Z', 'CN')).toBe('2026-10-31')
  })

  it('未知市场回退 CN', () => {
    expect(marketDateKey('2026-10-30T16:30:00Z', 'XX')).toBe(marketDateKey('2026-10-30T16:30:00Z', 'CN'))
  })

  it('空值返回空串 / false', () => {
    expect(marketDateKey(undefined, 'CN')).toBe('')
    expect(isSameMarketDay(null, 'CN')).toBe(false)
  })
})
