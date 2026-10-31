import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { SuggestionBadge, type SuggestionInfo, type KlineSummary } from '@panwatch/biz-ui/components/suggestion-badge'
import { suggestionPresentation } from '@panwatch/biz-ui/components/suggestion-action'

afterEach(cleanup)
const technical = { trend: '多头排列', rsi_status: '超买' } as KlineSummary
const suggestion: SuggestionInfo = {
  action: 'watch', action_label: '观望', attention_required: true,
  signal: '风险上升', reason: '波动加大', should_alert: true,
  agent_name: 'premarket_outlook', agent_label: '盘前分析',
}

describe('suggestion badges', () => {
  it('shows a single indicator badge without fabricating an AI result', () => {
    render(<SuggestionBadge suggestion={null} kline={technical} hasPosition />)
    expect(screen.getAllByRole('button', { name: '持有·1分' })).toHaveLength(1)
    expect(screen.queryByText('AI')).toBeNull()
    expect(screen.queryByText(/指标 ·/)).toBeNull()
  })
  it('keeps the AI corner tag, independent attention state and technical action', () => {
    render(<SuggestionBadge suggestion={suggestion} kline={technical} hasPosition />)
    expect(screen.getByRole('button', { name: '提醒 AI' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '指标 · 持有·1分' })).toBeTruthy()
    expect(screen.getByText('AI').className).toContain('absolute')
    expect(screen.queryByText(/AI ·/)).toBeNull()
    expect(screen.getByRole('button', { name: '指标 · 持有·1分' })).toBeTruthy()
  })
  it('prints the technical score after the action, and hides it when neutral', () => {
    const { rerender } = render(<SuggestionBadge suggestion={null} kline={{ trend: '均线交织' } as KlineSummary} hasPosition />)
    expect(screen.getByRole('button', { name: '观望' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /观望·/ })).toBeNull()
    rerender(<SuggestionBadge suggestion={null} kline={{ trend: '多头排列' } as KlineSummary} hasPosition />)
    expect(screen.getByRole('button', { name: '持有·2分' })).toBeTruthy()
  })
  it('does not display watch as the conclusion of missing technical data', () => {
    render(<SuggestionBadge suggestion={suggestion} kline={null} />)
    expect(screen.getByRole('button', { name: '指标 · 暂无数据' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '观望' })).toBeNull()
  })
  it('recovers REVIEW from an old label even when the stored direction is hold', () => {
    render(<SuggestionBadge suggestion={{ ...suggestion, action: 'hold', action_label: '待人工复核',
      agent_name: 'tradingagents', attention_required: false }} showTechnicalCompanion={false} />)
    expect(screen.getByRole('button', { name: '待复核 AI' })).toBeTruthy()
    expect(screen.queryByText('持有')).toBeNull()
  })
  it('preserves attention and review in English', async () => {
    await i18n.changeLanguage('en-US')
    const { rerender } = render(<SuggestionBadge suggestion={suggestion} showTechnicalCompanion={false} />)
    expect(screen.getByRole('button', { name: 'Alert AI' })).toBeTruthy()
    rerender(<SuggestionBadge suggestion={{ ...suggestion, action: 'hold', rating_raw: 'review',
      review_required: true }} showTechnicalCompanion={false} />)
    expect(screen.getByRole('button', { name: 'Review required AI' })).toBeTruthy()
  })
  it('recovers five-tier ratings and persisted state without conflating them', () => {
    expect(suggestionPresentation({ action: 'buy', action_label: '增持' }).action).toBe('add')
    expect(suggestionPresentation({ action: 'sell', rating_raw: 'underweight' }).action).toBe('reduce')
    expect(suggestionPresentation({ action: 'hold', meta: { suggestion_state: { review_required: true } } }).review).toBe(true)
  })
  it('keeps a research buy visible alongside its execution restriction in both languages', async () => {
    const research = { ...suggestion, action: 'buy', action_label: '买入', attention_required: false,
      review_required: true, outlook: 'bullish' as const, confidence: .8, execution_status: 'blocked' as const }
    await i18n.changeLanguage('zh-CN')
    const { rerender } = render(<SuggestionBadge suggestion={research} showTechnicalCompanion={false} />)
    expect(screen.getByRole('button', { name: '买入 · 执行受限 AI' })).toBeTruthy()
    expect(suggestionPresentation(research).action).toBe('buy')
    expect(screen.queryByRole('button', { name: '观望 AI' })).toBeNull()
    await i18n.changeLanguage('en-US')
    rerender(<SuggestionBadge suggestion={research} showTechnicalCompanion={false} />)
    expect(screen.getByRole('button', { name: 'Buy · Execution blocked AI' })).toBeTruthy()
  })
})

describe('non-order research advice', () => {
  it.each(['watch', 'hold', 'avoid'])('does not mark %s as blocked merely because the archived model said so', action => {
    const view = suggestionPresentation({ action, outlook: 'neutral', execution_status: 'blocked' })
    expect(view.stateLabelKey).toBeNull()
    expect(view.colorClass).not.toContain('orange')
    expect(view.action).toBe(action)
  })
})

// 悬停提示走的是原生 title：不点进弹窗也要能读到 AI 说了什么。
// 上面的用例会把 i18n 切到 en-US 且不还原，这里必须每次重置。
describe('ai badge hover tip', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-CN') })
  const tipOf = (el: HTMLElement) => el.getAttribute('title') || ''

  it('shows the signal and the reason, then the hint to open the dialog', () => {
    render(<SuggestionBadge suggestion={suggestion} showTechnicalCompanion={false} />)
    const tip = tipOf(screen.getByRole('button', { name: '提醒 AI' }))
    expect(tip).toContain('信号：风险上升')
    expect(tip).toContain('理由：波动加大')
    expect(tip.endsWith('点击查看建议详情')).toBe(true)
  })

  it('wraps a long reason into three lines and truncates instead of overflowing', () => {
    const longReason = '政策面与资金面同时转弱，需要继续观察成交量能否放大'.repeat(10)
    render(<SuggestionBadge suggestion={{ ...suggestion, signal: '', reason: longReason }} showTechnicalCompanion={false} />)
    const lines = tipOf(screen.getByRole('button', { name: '提醒 AI' })).split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[2].endsWith('…')).toBe(true)
    expect(lines[3]).toBe('点击查看建议详情')
  })

  it('falls back to the plain hint when there is neither signal nor reason', () => {
    render(<SuggestionBadge suggestion={{ ...suggestion, signal: '', reason: '' }} showTechnicalCompanion={false} />)
    expect(tipOf(screen.getByRole('button', { name: '提醒 AI' }))).toBe('点击查看建议详情')
  })

  it('echoes the coloured indicator chips from the detail view, and only those', () => {
    const kline = {
      trend: '多头排列', macd_status: '金叉', // 详情页里这两枚恒为灰色，不该被摘要当成命中
      rsi_status: '超买', rsi6: 85.4,
      boll_status: '突破上轨',
      kline_pattern: '大阳线',
      support: 12.345, resistance: 15.678,
    } as KlineSummary
    render(<SuggestionBadge suggestion={suggestion} kline={kline} hasPosition showTechnicalCompanion={false} />)
    const tip = tipOf(screen.getByRole('button', { name: '提醒 AI' }))
    expect(tip).toContain('技术指标')
    expect(tip).toContain('RSI 超买 (85)')
    expect(tip).toContain('BOLL 突破上轨')
    expect(tip).toContain('大阳线')
    expect(tip).toContain('支撑 12.35 / 压力 15.68')
    expect(tip).not.toContain('多头排列')
    expect(tip).not.toContain('MACD 金叉')
  })

  it('omits the technical block entirely when no chip is coloured', () => {
    const kline = { trend: '均线交织', rsi_status: '中性' } as KlineSummary
    render(<SuggestionBadge suggestion={suggestion} kline={kline} showTechnicalCompanion={false} />)
    const tip = tipOf(screen.getByRole('button', { name: '提醒 AI' }))
    expect(tip).not.toContain('技术指标')
    expect(tip).not.toContain('无命中')
  })
})
