import { describe, expect, it } from 'vitest'
import type { DeepAnalysisResult } from '@panwatch/api'
import { buildTaInfo, taConfidenceText, taToneCls } from './ta-badge'

function makeResult(suggestion: Partial<DeepAnalysisResult['raw_data']['suggestion']> | null): DeepAnalysisResult {
  return {
    agent_name: 'tradingagents',
    title: 't',
    content: 'c',
    raw_data: suggestion
      ? ({ suggestion: { action: 'hold', action_label: '持有', signal: '', reason: '', confidence: 5, should_alert: false, agent_name: 'tradingagents', agent_label: 'TradingAgents', ...suggestion } as DeepAnalysisResult['raw_data']['suggestion'] })
      : ({} as DeepAnalysisResult['raw_data']),
    analysis_date: '2026-10-30',
    generated_at: '2026-10-30T15:10:00+08:00',
  } as DeepAnalysisResult
}

describe('buildTaInfo', () => {
  it('returns null when there is no suggestion', () => {
    expect(buildTaInfo(null)).toBeNull()
    expect(buildTaInfo(makeResult(null))).toBeNull()
  })

  it('extracts rating, confidence and one-liner', () => {
    const info = buildTaInfo(makeResult({
      action: 'buy',
      action_label: '买入',
      rating_raw: 'overweight',
      confidence: 7.2,
      signal: '🟢 突破放量\n第二行应被丢弃',
    }))
    expect(info).not.toBeNull()
    expect(info?.action).toBe('buy')
    expect(info?.action_label).toBe('买入')
    expect(info?.rating_raw).toBe('overweight')
    expect(info?.confidence).toBe(7.2)
    expect(info?.one_liner).toBe('突破放量')
    expect(info?.analysis_date).toBe('2026-10-30')
  })

  it('marks review_required and keeps unknown confidence as null', () => {
    const info = buildTaInfo(makeResult({
      action: 'hold',
      action_label: '待复核',
      rating_raw: 'review',
      review_required: true,
      confidence: Number.NaN,
    }))
    expect(info?.review_required).toBe(true)
    expect(info?.confidence).toBeNull()
  })
})

describe('taConfidenceText', () => {
  it('renders a labelled one-decimal fragment', () => {
    expect(taConfidenceText(5)).toBe('· 置信度5.0')
    expect(taConfidenceText(7.26)).toBe('· 置信度7.3')
  })

  it('returns null when confidence is missing or not finite', () => {
    expect(taConfidenceText(null)).toBeNull()
    expect(taConfidenceText(undefined)).toBeNull()
    expect(taConfidenceText(Number.NaN)).toBeNull()
    expect(taConfidenceText(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('taToneCls', () => {
  it('review always wins over action colour', () => {
    expect(taToneCls('buy', true)).toContain('orange')
  })

  it('maps actions to market/neutral tones', () => {
    expect(taToneCls('buy', false)).toContain('market-up')
    expect(taToneCls('overweight', false)).toContain('market-up')
    expect(taToneCls('underweight', false)).toContain('market-down')
    expect(taToneCls('sell', false)).toContain('market-down')
    expect(taToneCls('hold', false)).toContain('amber')
    expect(taToneCls('avoid', false)).toContain('red')
    expect(taToneCls('watch', false)).toContain('slate')
  })
})
