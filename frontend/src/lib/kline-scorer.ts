import type { KlineSummaryData } from '@panwatch/biz-ui/components/kline-summary-dialog'

export type Action = 'buy' | 'add' | 'reduce' | 'sell' | 'hold' | 'watch' | 'avoid'

export interface KlineEvidenceItem {
  text: string
  details?: string
  delta: number
  tag?: string
}

export interface KlineScoreSuggestion {
  action: Action
  action_label: string
  signal: string
  score: number
  evidence: KlineEvidenceItem[]
  tags: string[]
}

export type KlineTranslate = (key: string, options?: Record<string, unknown>) => string

/**
 * 技术评分的实战可达上限（对称，故只存一个数）。
 *
 * 八项加减累加的**纯数学**范围是 ±10，但 ±10 要求「价格突破布林上轨」与「贴近支撑位
 * （收盘 ≤ 支撑 ×1.02）」同时成立——价格既在带上轨之上又在支撑位附近，行情里不可能出现；
 * 负向同理（跌破下轨 + 贴近压力位）。剔除这类自相矛盾的组合后，可达区间是 −9 ~ +9，
 * 且 +9 / −9 各只有 2 种状态组合（8 项里 7 项同时成立）。
 *
 * UI 的强度条与上限刻度都用这个值，**不写死 10**，否则条永远填不满、看着像系统坏了。
 * 改动打分规则（增删维度或调整权重）后必须回头复核此值。
 */
export const KLINE_SCORE_LIMIT = 9

export function buildKlineSuggestion(s: KlineSummaryData, holding: boolean | undefined, tr: KlineTranslate): KlineScoreSuggestion {
  let score = 0
  const items: KlineEvidenceItem[] = []
  const tags: string[] = []

  const addItem = (key: string, delta: number = 0, tagKey?: string) => {
    const text = tr(`items.${key}`)
    const tag = tagKey ? tr(`tags.${tagKey}`) : undefined
    items.push({ text, delta, tag })
    score += delta
    if (tag) tags.push(tag)
  }

  // Trend
  if (s.trend?.includes('多头')) {
    addItem('trendBull', 2, 'bullish')
  } else if (s.trend?.includes('空头')) {
    addItem('trendBear', -2, 'bearish')
  } else if (s.trend?.includes('交织')) {
    addItem('trendMixed')
  }

  // MACD
  if (s.macd_status?.includes('金叉')) {
    addItem('macdGolden', 2, 'macdGolden')
  }
  if (s.macd_status?.includes('死叉')) {
    addItem('macdDeath', -2, 'macdDeath')
  }
  if (s.macd_hist != null) {
    if (s.macd_hist > 0.0) {
      addItem('macdPositive', 1)
    } else if (s.macd_hist < 0.0) {
      addItem('macdNegative', -1)
    }
  }

  // RSI
  if (s.rsi_status?.includes('超卖')) {
    addItem('rsiOversold', 1, 'rsiOversold')
  } else if (s.rsi_status?.includes('偏强')) {
    addItem('rsiStrong', 1, 'rsiStrong')
  } else if (s.rsi_status?.includes('超买')) {
    addItem('rsiOverbought', -1, 'rsiOverbought')
  } else if (s.rsi_status?.includes('偏弱')) {
    addItem('rsiWeak', -1, 'rsiWeak')
  } else if (s.rsi_status?.includes('中性')) {
    addItem('rsiNeutral')
  }

  // KDJ
  if (s.kdj_status?.includes('金叉')) {
    addItem('kdjGolden', 1, 'kdjGolden')
  }
  if (s.kdj_status?.includes('死叉')) {
    addItem('kdjDeath', -1, 'kdjDeath')
  }

  // BOLL
  if (s.boll_status?.includes('突破上轨')) {
    addItem('bollUpper', 1, 'bollUpper')
  } else if (s.boll_status?.includes('跌破下轨')) {
    addItem('bollLower', -1, 'bollLower')
  }

  // Volume
  if (s.volume_trend?.includes('放量')) {
    addItem('volumeUp', 1, 'volumeUp')
  } else if (s.volume_trend?.includes('缩量')) {
    addItem('volumeDown', -1, 'volumeDown')
  }

  // Support / Resistance proximity
  if (s.last_close != null && s.support != null && s.support > 0) {
    if (s.last_close <= s.support * 1.02) {
      addItem('nearSupport', 1, 'nearSupport')
    }
  }
  if (s.last_close != null && s.resistance != null && s.resistance > 0) {
    if (s.last_close >= s.resistance * 0.98) {
      addItem('nearResistance', -1, 'nearResistance')
    }
  }

  const holdingFlag = holding === true
  let action: Action
  if (holdingFlag) {
    if (score >= 3) action = 'add'
    else if (score >= 1) action = 'hold'
    else if (score <= -3) action = 'sell'
    else if (score <= -1) action = 'reduce'
    else action = 'watch'
  } else {
    if (score >= 3) action = 'buy'
    else if (score <= -2) action = 'avoid'
    else action = 'watch'
  }

  const uniqTags = Array.from(new Set(tags))
  const signal = uniqTags.length > 0 ? uniqTags.join(' / ') : tr('neutralSignal')

  return {
    action,
    action_label: tr(`actions.${action}`),
    signal,
    score,
    evidence: items,
    tags: uniqTags,
  }
}
