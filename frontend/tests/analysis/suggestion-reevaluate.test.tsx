import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { insightApi, stocksApi } from '@panwatch/api'
import { SuggestionBadge, type SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

let suggestionsSpy: any
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
  // 默认返回空列表：避免旧用例触发真实网络请求
  suggestionsSpy = vi.spyOn(insightApi, 'suggestions').mockResolvedValue([] as any)
})

const aiSuggestion: SuggestionInfo = {
  action: 'hold',
  action_label: '持有',
  signal: '趋势平稳',
  reason: '维持现有判断',
  should_alert: false,
  agent_name: 'premarket_outlook',
  agent_label: '盘前分析',
  created_at: '2026-10-30T01:00:00Z',
}

function openDetail() {
  // 持仓页模式下 AI 徽章的 title 固定是 detailTitle
  fireEvent.click(screen.getByTitle(/点击查看建议详情/))
}

describe('AI 徽章「重新评估」入口', () => {
  it('有 agent 来源且传了 stockSymbol 时，详情弹窗展示「重新评估」按钮', () => {
    render(
      <SuggestionBadge
        suggestion={aiSuggestion}
        stockSymbol="600519"
        stockName="贵州茅台"
        market="CN"
        hasPosition
      />,
    )
    openDetail()
    expect(screen.getByRole('button', { name: '重新评估' })).toBeTruthy()
  })

  it('纯技术指标徽章（technical_fallback）不展示「重新评估」', () => {
    render(
      <SuggestionBadge
        suggestion={{ ...aiSuggestion, agent_name: 'technical_fallback', agent_label: '技术指标' }}
        stockSymbol="600519"
        market="CN"
      />,
    )
    openDetail()
    expect(screen.queryByRole('button', { name: '重新评估' })).toBeNull()
  })

  it('缺少 stockSymbol 时不展示（无法定位单只标的）', () => {
    render(<SuggestionBadge suggestion={aiSuggestion} market="CN" />)
    openDetail()
    expect(screen.queryByRole('button', { name: '重新评估' })).toBeNull()
  })

  it('点击后以正确的 agent / 单只参数触发，并调用刷新回调', async () => {
    const spy = vi
      .spyOn(stocksApi, 'triggerAgent')
      .mockResolvedValue({ queued: false, success: true, message: 'ok' } as any)
    const onReEvaluated = vi.fn().mockResolvedValue(undefined)
    render(
      <SuggestionBadge
        suggestion={aiSuggestion}
        stockSymbol="600519"
        stockName="贵州茅台"
        market="CN"
        onReEvaluated={onReEvaluated}
      />,
    )
    openDetail()
    fireEvent.click(screen.getByRole('button', { name: '重新评估' }))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith(
      0,
      'premarket_outlook',
      expect.objectContaining({
        allow_unbound: true,
        symbol: '600519',
        market: 'CN',
        name: '贵州茅台',
        bypass_throttle: true,
        bypass_market_hours: true,
        force_refresh: true,
      }),
    )
    await vi.waitFor(() => expect(onReEvaluated).toHaveBeenCalled())
  })
})

// ---- 重跑后的「最新结果」对比卡 ----

const HOUR = 3600_000

function baseSuggestion(over: Partial<SuggestionInfo> = {}): SuggestionInfo {
  return {
    id: 10,
    action: 'hold',
    action_label: '持有',
    signal: '趋势平稳',
    reason: '维持现有判断',
    should_alert: false,
    agent_name: 'premarket_outlook',
    agent_label: '盘前分析',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...over,
  }
}

function probeSequence(seq: SuggestionInfo[][]) {
  // 弹窗打开时组件会先拉一次单票历史用于分 tab（TA / workflow），
  // 这里垫一条空响应，让后面的序列仍对应「重新评估」的轮询探测
  const all: SuggestionInfo[][] = [[], ...seq]
  let i = 0
  suggestionsSpy.mockImplementation(async () => {
    const res = all[Math.min(i, all.length - 1)] ?? []
    i += 1
    return res as any
  })
}

function renderBadge(s: SuggestionInfo, onReEvaluated = vi.fn()) {
  render(
    <SuggestionBadge
      suggestion={s}
      stockSymbol="600519"
      stockName="贵州茅台"
      market="CN"
      onReEvaluated={onReEvaluated}
    />,
  )
  openDetail()
}

function clickReevaluate() {
  fireEvent.click(screen.getByRole('button', { name: '重新评估' }))
}

describe('重新评估：当天结果不覆盖、下方显示最新结果', () => {
  it('当天 + 有新行：主区保留原结果，下方出现「最新结果」卡', async () => {
    const base = baseSuggestion()
    const latest = baseSuggestion({
      id: 11,
      action: 'reduce',
      action_label: '减仓',
      signal: '放量下跌',
      reason: '跌破关键支撑，建议减仓',
      ai_response: 'RAW-新结果',
    })
    probeSequence([[base], [latest]])
    vi.spyOn(stocksApi, 'triggerAgent').mockResolvedValue({ queued: true } as any)

    renderBadge(base)
    clickReevaluate()

    await vi.waitFor(() => expect(screen.getByText('最新结果')).toBeTruthy())
    // 主区仍是打开弹窗时看到的那条
    expect(screen.getByText('趋势平稳')).toBeTruthy()
    expect(screen.getByText('维持现有判断')).toBeTruthy()
    // 对比卡里是本次重跑的新结果
    expect(screen.getByText('放量下跌')).toBeTruthy()
  })

  it('当天 + 去重（仅 expires_at 延长）：下方显示「结论未变」', async () => {
    const base = baseSuggestion()
    const same = baseSuggestion({ expires_at: new Date(Date.now() + 60 * 60_000).toISOString() })
    probeSequence([[base], [same]])
    vi.spyOn(stocksApi, 'triggerAgent').mockResolvedValue({ queued: true } as any)

    renderBadge(base)
    clickReevaluate()

    await vi.waitFor(() => expect(screen.getByText('结论未变')).toBeTruthy())
  })

  it('非当天 + 有新行：主区直接替换，不出现「最新结果」卡', async () => {
    const base = baseSuggestion({ created_at: new Date(Date.now() - 36 * HOUR).toISOString() })
    const latest = baseSuggestion({ id: 11, signal: '新信号', reason: '新理由' })
    probeSequence([[base], [latest]])
    vi.spyOn(stocksApi, 'triggerAgent').mockResolvedValue({ queued: true } as any)

    renderBadge(base)
    clickReevaluate()

    await vi.waitFor(() => expect(screen.getByText('新信号')).toBeTruthy())
    expect(screen.queryByText('最新结果')).toBeNull()
  })

  it('展开全文：展开前 ai_response 不在 DOM，点击后出现', async () => {
    const base = baseSuggestion()
    const latest = baseSuggestion({ id: 11, signal: '放量下跌', ai_response: 'RAW-新结果' })
    probeSequence([[base], [latest]])
    vi.spyOn(stocksApi, 'triggerAgent').mockResolvedValue({ queued: true } as any)

    renderBadge(base)
    clickReevaluate()

    await vi.waitFor(() => expect(screen.getByText('最新结果')).toBeTruthy())
    expect(screen.queryByText('RAW-新结果')).toBeNull()
    fireEvent.click(screen.getByText('展开全文'))
    expect(screen.getByText('RAW-新结果')).toBeTruthy()
  })

  it('90s 内既无新行也无 expires_at 变化：提示稍后重试', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const base = baseSuggestion()
    const still = baseSuggestion()
    probeSequence([[base], [still], [still]])
    vi.spyOn(stocksApi, 'triggerAgent').mockResolvedValue({ queued: true } as any)

    renderBadge(base)
    clickReevaluate()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(95_000)

    expect(screen.getByText(/暂未收到新结果/)).toBeTruthy()
  })
})
