/**
 * 同花顺个股页链接。
 *
 * 2026-10-30 用浏览器 UA 逐只实测确认的三条规则（全库 24 只 + 边界码全部命中）：
 * - A 股：/600519/      6 位裸码，同花顺**不要** sh/sz/bj 前缀（雪球才要）
 * - 港股：/HK9868/      系统内港码是 5 位补零（09868），同花顺是 HK + 4 位，必须去前导零再补满
 *                       反证：直拼 /HK00700/ 会 302 跳首页
 * - 美股：/BRK.B/       点号保留；系统内用下划线（BRK_B），要转成点号
 *                       反证：直拼 /BRK_B/ 会掉到「个股频道」通用页
 *
 * 拼不出合法地址时返回 null，调用方不渲染标签——给一个 302 回首页的死链比不给更糟。
 */
const THS_ORIGIN = 'https://stockpage.10jqka.com.cn'

const CN_CODE = /^\d{6}$/
const HK_CODE = /^\d{1,4}$/
// 单段 ticker 或带一个类别后缀（BRK.B）；EONR_WS / NE_WS_A 这类权证同花顺没有个股页
const US_TICKER = /^[A-Z]{1,6}(?:\.[A-Z])?$/

export function toThsPath(symbol: string, market?: string | null): string | null {
  const raw = (symbol || '').trim().toUpperCase()
  if (!raw) return null

  switch ((market || '').trim().toUpperCase()) {
    case 'CN': {
      // 手工录入的可能是 sh600519 / 600519.SH，剥掉前缀后缀
      const code = raw.replace(/^(?:SH|SZ|BJ)(?=\d)/, '').replace(/\.(?:SH|SZ|BJ)$/, '')
      return CN_CODE.test(code) ? `${code}/` : null
    }
    case 'HK': {
      if (!/^\d+$/.test(raw)) return null
      const digits = raw.replace(/^0+/, '') || '0'
      // 89988 / 85904 这类 5 位人民币柜台在新版同花顺没有个股页，直拼只会 302 回首页
      return HK_CODE.test(digits) ? `HK${digits.padStart(4, '0')}/` : null
    }
    case 'US': {
      const ticker = raw.replace(/[-_]/g, '.')
      return US_TICKER.test(ticker) ? `${ticker}/` : null
    }
    default:
      return null
  }
}

export function thsUrl(symbol: string, market?: string | null): string | null {
  const path = toThsPath(symbol, market)
  return path ? `${THS_ORIGIN}/${path}` : null
}
