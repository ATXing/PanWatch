import { describe, expect, it } from 'vitest'

import { thsUrl, toThsPath } from './stock-links'

const BASE = 'https://stockpage.10jqka.com.cn'

describe('toThsPath', () => {
  it('A 股使用 6 位裸码，不加交易所前缀', () => {
    expect(toThsPath('600519', 'CN')).toBe('600519/')
    expect(toThsPath('000858', 'CN')).toBe('000858/')
    expect(toThsPath('688363', 'CN')).toBe('688363/')
    // 场内 ETF / 北交所同样是 6 位
    expect(toThsPath('563230', 'CN')).toBe('563230/')
    expect(toThsPath('830799', 'CN')).toBe('830799/')
  })

  it('A 股容忍带前缀后缀的写法', () => {
    expect(toThsPath('sh600519', 'CN')).toBe('600519/')
    expect(toThsPath('600519.SH', 'CN')).toBe('600519/')
  })

  it('A 股非法码返回 null', () => {
    expect(toThsPath('12345', 'CN')).toBeNull()
    expect(toThsPath('abcdef', 'CN')).toBeNull()
  })

  it('港股去前导零后补满 4 位并加 HK 前缀', () => {
    expect(toThsPath('09868', 'HK')).toBe('HK9868/')
    expect(toThsPath('00853', 'HK')).toBe('HK0853/')
    expect(toThsPath('00700', 'HK')).toBe('HK0700/')
    expect(toThsPath('03309', 'HK')).toBe('HK3309/')
    expect(toThsPath('09988', 'HK')).toBe('HK9988/')
    // 不足 4 位要补零
    expect(toThsPath('00002', 'HK')).toBe('HK0002/')
    expect(toThsPath('00075', 'HK')).toBe('HK0075/')
  })

  it('港股 5 位无前导零的人民币柜台码返回 null', () => {
    expect(toThsPath('89988', 'HK')).toBeNull()
    expect(toThsPath('85904', 'HK')).toBeNull()
    expect(toThsPath('89618', 'HK')).toBeNull()
  })

  it('美股类别股改用点号，权证不给链接', () => {
    expect(toThsPath('AAPL', 'US')).toBe('AAPL/')
    expect(toThsPath('BRK_B', 'US')).toBe('BRK.B/')
    expect(toThsPath('BRK-B', 'US')).toBe('BRK.B/')
    expect(toThsPath('BRK.B', 'US')).toBe('BRK.B/')
    expect(toThsPath('GLU_A', 'US')).toBe('GLU.A/')
    // 权证 / 多段后缀同花顺没有个股页
    expect(toThsPath('EONR_WS', 'US')).toBeNull()
    expect(toThsPath('NE_WS_A', 'US')).toBeNull()
    expect(toThsPath('LZM_WS', 'US')).toBeNull()
  })

  it('市场大小写与首尾空格容错', () => {
    expect(toThsPath(' 09868 ', 'hk')).toBe('HK9868/')
    expect(toThsPath('aapl', 'us')).toBe('AAPL/')
  })

  it('空值或不认识的市场返回 null', () => {
    expect(toThsPath('', 'CN')).toBeNull()
    expect(toThsPath('   ', 'HK')).toBeNull()
    expect(toThsPath('600519', '')).toBeNull()
    expect(toThsPath('600519', null)).toBeNull()
    expect(toThsPath('600519', undefined)).toBeNull()
  })
})

describe('thsUrl', () => {
  it('拼出完整的同花顺个股页地址', () => {
    expect(thsUrl('600519', 'CN')).toBe(`${BASE}/600519/`)
    expect(thsUrl('09868', 'HK')).toBe(`${BASE}/HK9868/`)
    expect(thsUrl('00853', 'HK')).toBe(`${BASE}/HK0853/`)
    expect(thsUrl('BRK_B', 'US')).toBe(`${BASE}/BRK.B/`)
  })

  it('拼不出时返回 null 而不是半截地址', () => {
    expect(thsUrl('89988', 'HK')).toBeNull()
    expect(thsUrl('EONR_WS', 'US')).toBeNull()
    expect(thsUrl('', 'CN')).toBeNull()
  })
})
