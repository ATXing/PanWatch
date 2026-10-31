import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import StocksPage from '@/pages/Stocks'
import { MarketColorProvider } from '@/hooks/use-market-colors'

vi.mock('@panwatch/api', async importOriginal => ({
  ...await importOriginal<typeof import('@panwatch/api')>(),
  fetchAPI: vi.fn(),
}))
vi.mock('@panwatch/api/klines', () => ({ klinesApi: { summaryBatch: vi.fn().mockResolvedValue({}) } }))

afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })

const total = {
  total_market_value: 15000,
  total_cost: 14000,
  total_pnl: 1000,
  total_pnl_pct: 7.14,
  total_daily_pnl: 177.87,
  available_funds: 50000,
  total_assets: 65000,
  total_net_pnl: 900,
  total_net_pnl_pct: 6.43,
}

const instrument = { id: 1, symbol: '600519', name: '贵州茅台', market: 'CN', asset_type: 'stock', agents: [] }

// 汇总卡的 total 是 mergePortfolioQuotes 从持仓明细重算的，positions 必须给真值：
// 总市值 = 1500 × 10 = 15000 → formatMoney = '1.50万'
const setupPage = async () => {
  vi.mocked(fetchAPI).mockImplementation(async path => {
    if (path === '/stocks') return [instrument]
    if (path.startsWith('/portfolio/summary')) return {
      accounts: [{
        id: 1,
        name: '测试账户',
        available_funds: 50000,
        total_market_value: 15000,
        positions: [{ id: 1, stock_id: 1, symbol: '600519', name: '贵州茅台', market: 'CN', asset_type: 'stock', cost_price: 1400, quantity: 10, current_price: 1500, change_pct: 1.2 }],
      }],
      total,
    }
    if (path.startsWith('/portfolio/positions')) return []
    if (path === '/quotes/batch') return [{ symbol: '600519', market: 'CN', current_price: 1500, change_pct: 1.2 }]
    if (path.startsWith('/suggestions')) return {}
    return []
  })
  render(<MemoryRouter><MarketColorProvider><StocksPage /></MarketColorProvider></MemoryRouter>)
  // 等汇总卡渲染完成
  await screen.findByTestId('portfolio-summary')
  await screen.findAllByText('总市值')
}

it('shows portfolio amounts by default and masks them when the privacy eye is toggled', async () => {
  await setupPage()
  const summary = within(screen.getByTestId('portfolio-summary'))
  // 默认显示：汇总卡渲染真实金额（总市值 1.50万 / 可用资金 5.00万）
  expect(summary.getAllByText('1.50万').length).toBeGreaterThan(0)
  expect(summary.getAllByText('5.00万').length).toBeGreaterThan(0)

  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '隐藏/显示持仓金额' }))

  // 打码后：汇总卡内真实数字不渲染进 DOM，统一显示 ••••
  await waitFor(() => expect(summary.queryAllByText('1.50万')).toHaveLength(0))
  expect(summary.getAllByText('••••').length).toBeGreaterThanOrEqual(6)
  expect(localStorage.getItem('panwatch_stocks_privacyHidden')).toBe('true')

  // 账户行（测试账户后面的市值/盈亏/可用资金）同步打码
  const accountAmounts = within(screen.getByTestId('account-amounts-1'))
  await waitFor(() => expect(accountAmounts.queryAllByText('1.50万')).toHaveLength(0))
  expect(accountAmounts.getAllByText('••••').length).toBeGreaterThanOrEqual(4)

  // 再点恢复：汇总卡与账户行都恢复真实金额
  await user.click(screen.getByRole('button', { name: '隐藏/显示持仓金额' }))
  await waitFor(() => expect(summary.getAllByText('1.50万').length).toBeGreaterThan(0))
  expect(accountAmounts.getAllByText('1.50万').length).toBeGreaterThan(0)
  expect(localStorage.getItem('panwatch_stocks_privacyHidden')).toBe('false')
})

it('keeps amounts masked after a reload when the preference is stored', async () => {
  localStorage.setItem('panwatch_stocks_privacyHidden', 'true')
  await setupPage()
  const summary = within(screen.getByTestId('portfolio-summary'))
  // 汇总卡与账户行全程打码
  expect(summary.queryAllByText('1.50万')).toHaveLength(0)
  expect(summary.queryAllByText('5.00万')).toHaveLength(0)
  expect(summary.getAllByText('••••').length).toBeGreaterThanOrEqual(6)
  expect(within(screen.getByTestId('account-amounts-1')).getAllByText('••••').length).toBeGreaterThanOrEqual(4)
  // 点眼睛恢复显示
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '隐藏/显示持仓金额' }))
  await waitFor(() => expect(summary.getAllByText('1.50万').length).toBeGreaterThan(0))
})
