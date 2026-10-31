import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insightApi, stocksApi } from '@panwatch/api'
import { SuggestionBadge, type SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'

// 场景来自真库：安踏 02020 同时有 tradingagents（id 105）与 intraday_monitor（id 102）两条建议，
// 建议池列表接口只回 MAX(id) 那条（TA），所以弹窗必须另外把 workflow 那条捞回来放进第二个 tab。
const taSuggestion: SuggestionInfo = {
  id: 105,
  action: 'hold',
  action_label: '持有',
  signal: 'TA 信号：估值合理',
  reason: 'TA 理由：四类分析师一致中性',
  should_alert: false,
  agent_name: 'tradingagents',
  agent_label: 'TradingAgents 深度',
  created_at: '2026-10-31T06:34:56',
}

const intradaySuggestion: SuggestionInfo = {
  id: 102,
  action: 'watch',
  action_label: '观望',
  signal: '盘中信号：量能萎缩',
  reason: '盘中理由：无实质变化',
  should_alert: false,
  agent_name: 'intraday_monitor',
  agent_label: '盘中监测',
  created_at: '2026-10-30T06:30:24',
}

function mockPerStockList(list: SuggestionInfo[]) {
  vi.spyOn(insightApi, 'suggestions').mockResolvedValue(list as never)
}

function renderBadge(suggestion: SuggestionInfo, buttonName: string) {
  render(
    <SuggestionBadge
      suggestion={suggestion}
      stockSymbol="02020"
      market="HK"
      stockName="安踏体育"
      showTechnicalCompanion={false}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: buttonName }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('suggestion dialog tabs', () => {
  it('keeps both sides and defaults to the side the badge is showing', async () => {
    mockPerStockList([taSuggestion, intradaySuggestion])
    renderBadge(taSuggestion, '持有 AI')

    const taTab = await screen.findByRole('tab', { name: 'TA' })
    const workflowTab = screen.getByRole('tab', { name: 'AI 建议' })
    expect(taTab.getAttribute('aria-selected')).toBe('true')
    expect(workflowTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getByText('TA 理由：四类分析师一致中性')).toBeTruthy()
  })

  it('switches to the workflow conclusion when its tab is picked', async () => {
    mockPerStockList([taSuggestion, intradaySuggestion])
    renderBadge(taSuggestion, '持有 AI')

    // Radix Tabs 默认按 mousedown 激活（自动激活模式），只 fire click 不会切
    const workflowTab = await screen.findByRole('tab', { name: 'AI 建议' })
    fireEvent.mouseDown(workflowTab)
    fireEvent.click(workflowTab)
    expect(await screen.findByText('盘中理由：无实质变化')).toBeTruthy()
    expect(screen.queryByText('TA 理由：四类分析师一致中性')).toBeNull()
  })

  it('renders no tabs when only the badge side exists', async () => {
    mockPerStockList([intradaySuggestion])
    renderBadge(intradaySuggestion, '观望 AI')

    expect(await screen.findByText('盘中理由：无实质变化')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('TA tab 是纯展示：不出现「重新评估」（TA 重跑在 🧠 深度分析弹窗里）', async () => {
    mockPerStockList([taSuggestion, intradaySuggestion])
    const trigger = vi
      .spyOn(stocksApi, 'triggerAgent')
      .mockResolvedValue({ queued: false, success: true, message: 'ok' } as never)
    renderBadge(taSuggestion, '持有 AI')

    // 徽章是 TA，默认落在 TA tab
    const taTab = await screen.findByRole('tab', { name: 'TA' })
    expect(taTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('TA 理由：四类分析师一致中性')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重新评估' })).toBeNull()

    // 切到 AI 建议 tab 才出现，且重跑对象一定不是 tradingagents
    const workflowTab = screen.getByRole('tab', { name: 'AI 建议' })
    fireEvent.mouseDown(workflowTab)
    fireEvent.click(workflowTab)
    fireEvent.click(await screen.findByRole('button', { name: '重新评估' }))
    await vi.waitFor(() => expect(trigger).toHaveBeenCalledTimes(1))
    expect(trigger.mock.calls[0][1]).toBe('intraday_monitor')
  })

  it('重新评估重跑的是 AI 建议侧的 agent，不会去重跑 TradingAgents', async () => {
    mockPerStockList([taSuggestion, intradaySuggestion])
    const spy = vi
      .spyOn(stocksApi, 'triggerAgent')
      .mockResolvedValue({ queued: false, success: true, message: 'ok' } as never)
    renderBadge(taSuggestion, '持有 AI')

    const workflowTab = await screen.findByRole('tab', { name: 'AI 建议' })
    fireEvent.mouseDown(workflowTab)
    fireEvent.click(workflowTab)
    fireEvent.click(await screen.findByRole('button', { name: '重新评估' }))

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith(
      0,
      'intraday_monitor',
      expect.objectContaining({ symbol: '02020', market: 'HK', allow_unbound: true, force_refresh: true }),
    )
    expect(spy.mock.calls[0][1]).not.toBe('tradingagents')
  })
})
