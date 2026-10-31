import type { DeepAnalysisResult } from '@panwatch/api'
import { normalizeSuggestionAction } from '@panwatch/biz-ui/components/suggestion-action'

/**
 * TradingAgents 徽章所需的摘要（只从 raw_data.suggestion 取标量，不存全文）。
 * 与 UZI 徽章不同：TA 是买卖决策，允许用涨跌色语义（沿用项目 market-up/down）。
 */
export interface TaInfo {
  /** 'YYYY-MM-DD' */
  analysis_date?: string
  /** ISO 时间，框下时间优先用它（比 analysis_date 更精确） */
  generated_at?: string
  action: string
  /** 后端已给的中文：买入/加仓/持有/减仓/卖出/回避/观望 */
  action_label: string
  /** 上游五档：buy/overweight/hold/underweight/sell/review */
  rating_raw?: string
  review_required?: boolean
  /** 0-10 分制 */
  confidence: number | null
  /** 悬停用的一句话（signal 或 reason 首行） */
  one_liner: string
}

/** 无内容 / 无 suggestion → null（= 确认没做过分析，可安全渲染空标签）。 */
export function buildTaInfo(result: DeepAnalysisResult | null): TaInfo | null {
  const suggestion = result?.raw_data?.suggestion
  if (!suggestion) return null
  const confidence =
    typeof suggestion.confidence === 'number' && Number.isFinite(suggestion.confidence)
      ? suggestion.confidence
      : null
  const oneLiner = (suggestion.signal || suggestion.reason || '').split('\n')[0].replace(/[🟢🔴🟡]\s*/g, '').trim()
  return {
    analysis_date: result?.analysis_date || result?.timestamp || undefined,
    generated_at: result?.generated_at || undefined,
    action: suggestion.action || 'watch',
    action_label: suggestion.action_label || '',
    rating_raw: suggestion.rating_raw || undefined,
    review_required: suggestion.review_required === true,
    confidence,
    one_liner: oneLiner,
  }
}

/**
 * 徽章内的置信度片段：「· 置信度7.2」（0-10 分制、一位小数）。
 * 与 AI 徽章的「·置信度72」同一套读法，避免裸数字看不出含义。无值返回 null（不占位）。
 */
export function taConfidenceText(confidence: number | null | undefined): string | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null
  return `· 置信度${confidence.toFixed(1)}`
}

/**
 * 评级 → 徽章配色。用 subtle 描边，保持与 UZI 同视觉重量，不抢同排的 SuggestionBadge。
 * review（待人工复核）单独走橙色，避免被误读成「持有」。
 */
export function taToneCls(action: string, review: boolean): string {
  if (review) return 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/50'
  switch (normalizeSuggestionAction(action)) {
    case 'buy':
    case 'add':
      return 'bg-market-up/15 text-market-up border-market-up/50'
    case 'reduce':
    case 'sell':
      return 'bg-market-down/15 text-market-down border-market-down/50'
    case 'hold':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/50'
    case 'avoid':
      return 'bg-red-600/15 text-red-700 dark:text-red-300 border-red-600/50'
    case 'alert':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/50'
    default:
      return 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/50'
  }
}
