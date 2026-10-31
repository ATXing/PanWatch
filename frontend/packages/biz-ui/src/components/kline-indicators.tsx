import { useTranslation } from 'react-i18next'
import { HoverPopover } from '@panwatch/base-ui/components/ui/hover-popover'
import type { KlineSummaryData } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { TechnicalBadge, type TechnicalBadgeTone } from '@panwatch/biz-ui/components/technical-badge'

interface KlineIndicatorsProps {
  summary: KlineSummaryData
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 详情页里的一枚指标徽章 */
export interface IndicatorChip {
  key: string
  label: string
  tone: TechnicalBadgeTone
  title: string
  description: string
  /** 支撑/压力自成一排，不跟状态混排 */
  levels?: boolean
}

export function localizeTechnicalStatus(value: string | null | undefined, tr: Translate): string {
  if (!value) return ''
  const rules: Array<[string, string]> = [
    ['多头', 'bullish'], ['空头', 'bearish'], ['交织', 'mixed'],
    ['金叉', 'goldenCross'], ['死叉', 'deathCross'], ['超买', 'overbought'],
    ['超卖', 'oversold'], ['偏强', 'strong'], ['偏弱', 'weak'],
    ['放量', 'volumeUp'], ['缩量', 'volumeDown'], ['突破上轨', 'upperBreak'],
    ['跌破下轨', 'lowerBreak'],
  ]
  const match = rules.find(([source]) => value.includes(source))
  return match ? tr(`statuses.${match[1]}`) : value
}

/**
 * 「技术指标」那排徽章的唯一数据源。
 * 抽出来是为了让 AI 徽章的悬停摘要和详情页永远说同一句话——两边各写一套必然会漂移
 * （比如这里给 RSI 补了 (85)，摘要里忘了补，同一个指标就变成两个样子）。
 */
export function buildIndicatorChips(s: KlineSummaryData, tr: Translate, english: boolean): IndicatorChip[] {
  const status = (value: string | null | undefined) => localizeTechnicalStatus(value, tr)
  const chips: IndicatorChip[] = []

  if (s.trend) {
    chips.push({ key: 'trend', label: status(s.trend), tone: 'neutral',
      title: tr('indicators.trend.title'), description: tr('indicators.trend.description') })
  }
  if (s.macd_status) {
    chips.push({ key: 'macd', label: `MACD ${status(s.macd_status)}`, tone: 'neutral',
      title: tr('indicators.macd.title'), description: tr('indicators.macd.description') })
  }
  if (s.rsi_status) {
    chips.push({
      key: 'rsi',
      label: `RSI ${status(s.rsi_status)}${s.rsi6 != null ? ` (${s.rsi6.toFixed(0)})` : ''}`,
      tone: s.rsi_status.includes('超买') ? 'bullish' : s.rsi_status.includes('超卖') ? 'bearish' : 'neutral',
      title: tr('indicators.rsi.title'), description: tr('indicators.rsi.description'),
    })
  }
  if (s.kdj_status) {
    chips.push({ key: 'kdj', label: `KDJ ${status(s.kdj_status)}`, tone: 'neutral',
      title: tr('indicators.kdj.title'), description: tr('indicators.kdj.description') })
  }
  if (s.volume_trend) {
    chips.push({
      key: 'volume',
      label: `${status(s.volume_trend)}${s.volume_ratio != null ? ` (${s.volume_ratio.toFixed(1)}x)` : ''}`,
      tone: s.volume_trend.includes('放量') ? 'warning' : s.volume_trend.includes('缩量') ? 'info' : 'neutral',
      title: tr('indicators.volume.title'), description: tr('indicators.volume.description'),
    })
  }
  if (s.boll_status) {
    chips.push({
      key: 'boll',
      label: `BOLL ${status(s.boll_status)}`,
      tone: s.boll_status.includes('突破上轨') ? 'bullish' : s.boll_status.includes('跌破下轨') ? 'bearish' : 'neutral',
      title: tr('indicators.boll.title'), description: tr('indicators.boll.description'),
    })
  }
  if (s.kline_pattern) {
    chips.push({
      key: 'pattern',
      label: english ? tr('indicators.pattern.title') : s.kline_pattern,
      tone: 'warning',
      title: tr('indicators.pattern.title'), description: tr('indicators.pattern.description'),
    })
  }
  if (s.support != null) {
    chips.push({
      key: 'support',
      label: tr('indicators.support.label', { value: s.support.toFixed(2) }),
      tone: 'bearish', levels: true,
      title: tr('indicators.support.title'), description: tr('indicators.support.description'),
    })
  }
  if (s.resistance != null) {
    chips.push({
      key: 'resistance',
      label: tr('indicators.resistance.label', { value: s.resistance.toFixed(2) }),
      tone: 'bullish', levels: true,
      title: tr('indicators.resistance.title'), description: tr('indicators.resistance.description'),
    })
  }
  return chips
}

/**
 * 悬停摘要用：只留详情页里「不是灰色」的状态徽章（tone 非 neutral）。
 * 支撑/压力不在这里出——摘要里那行数值由调用方单独拼，避免同一组数字出现两次。
 * 没有命中就返回空数组，调用方据此整块省略，不写「无命中」占位。
 */
export function hitIndicatorLabels(s: KlineSummaryData, tr: Translate, english: boolean): string[] {
  return buildIndicatorChips(s, tr, english)
    .filter(chip => !chip.levels && chip.tone !== 'neutral')
    .map(chip => chip.label)
}

function InternalChip({ chip }: { chip: IndicatorChip }) {
  return (
    <HoverPopover
      title={chip.title}
      content={<div>{chip.description}</div>}
      trigger={<TechnicalBadge label={chip.label} tone={chip.tone} help />}
    />
  )
}

export function KlineIndicators({ summary: s }: KlineIndicatorsProps) {
  const { t, i18n } = useTranslation('bizUi')
  const tr: Translate = (key, options) =>
    (t as unknown as Translate)(`kline.${key}`, options)
  const english = (i18n.resolvedLanguage || i18n.language).toLowerCase().startsWith('en')
  const chips = buildIndicatorChips(s, tr, english)
  const statusChips = chips.filter(chip => !chip.levels)
  const levelChips = chips.filter(chip => chip.levels)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-[11px]">
        {statusChips.map(chip => <InternalChip key={chip.key} chip={chip} />)}
      </div>
      {levelChips.length > 0 && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {levelChips.map(chip => <InternalChip key={chip.key} chip={chip} />)}
        </div>
      )}
    </div>
  )
}
