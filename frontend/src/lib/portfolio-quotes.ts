export interface DisplayQuote {
  current_price: number | null
  change_pct: number | null
  daily_move_status?: string
  quote_date?: string | null
}

export interface QuoteResponse extends DisplayQuote {
  symbol: string
  market: string
}

export interface FeeProfile {
  commission_rate: number
  min_commission: number
  stamp_duty_rate: number
  stamp_duty_sides: 'both' | 'buy' | 'sell'
  transfer_fee_rate: number
  misc_fee_rate: number
  misc_fee_sides: 'both' | 'buy' | 'sell'
}

// 与后端 src/modules/portfolio/fees.py 默认值保持一致（后端会随接口下发，此处仅兜底）
export const DEFAULT_FEE_PROFILES: Record<string, FeeProfile> = {
  CN: { commission_rate: 0.00025, min_commission: 5, stamp_duty_rate: 0.0005, stamp_duty_sides: 'sell', transfer_fee_rate: 0.00001, misc_fee_rate: 0, misc_fee_sides: 'both' },
  HK: { commission_rate: 0.0008, min_commission: 15, stamp_duty_rate: 0.001, stamp_duty_sides: 'both', transfer_fee_rate: 0, misc_fee_rate: 0.000058, misc_fee_sides: 'both' },
  US: { commission_rate: 0, min_commission: 0, stamp_duty_rate: 0, stamp_duty_sides: 'sell', transfer_fee_rate: 0, misc_fee_rate: 0.0000278, misc_fee_sides: 'sell' },
}

const ruleFee = (rate: number, sides: string, minAmount: number, side: 'buy' | 'sell', notional: number): number => {
  if (notional <= 0) return 0
  if (sides !== 'both' && sides !== side) return 0
  if (rate <= 0 && minAmount <= 0) return 0
  return Math.max(notional * rate, minAmount)
}

/** 净盈亏(含费口径): 市值 - 含买入费成本 - 预估卖出费。与后端 fees.py 同数学。 */
export const computeNetPnl = (
  costPrice: number,
  quantity: number,
  currentPrice: number,
  profile: FeeProfile
) => {
  const buyNotional = costPrice * quantity
  const buyFees =
    ruleFee(profile.commission_rate, 'both', profile.min_commission, 'buy', buyNotional) +
    ruleFee(profile.stamp_duty_rate, profile.stamp_duty_sides, 0, 'buy', buyNotional) +
    ruleFee(profile.transfer_fee_rate, 'both', 0, 'buy', buyNotional) +
    ruleFee(profile.misc_fee_rate, profile.misc_fee_sides, 0, 'buy', buyNotional)
  const netCost = buyNotional + buyFees
  const sellNotional = currentPrice * quantity
  const sellFees =
    ruleFee(profile.commission_rate, 'both', profile.min_commission, 'sell', sellNotional) +
    ruleFee(profile.stamp_duty_rate, profile.stamp_duty_sides, 0, 'sell', sellNotional) +
    ruleFee(profile.transfer_fee_rate, 'both', 0, 'sell', sellNotional) +
    ruleFee(profile.misc_fee_rate, profile.misc_fee_sides, 0, 'sell', sellNotional)
  const netPnl = sellNotional - sellFees - netCost
  return {
    net_cost: netCost,
    net_cost_price: quantity > 0 ? netCost / quantity : costPrice,
    total_fees: buyFees + sellFees,
    net_pnl: netPnl,
    net_pnl_pct: netCost > 0 ? (netPnl / netCost * 100) : 0,
  }
}

export interface Position {
  id: number
  stock_id: number
  sort_order?: number
  symbol: string
  name: string
  market: string
  asset_type?: 'stock' | 'etf'
  cost_price: number
  quantity: number
  invested_amount: number | null
  trading_style: string  // short: 短线, swing: 波段, long: 长线
  current_price: number | null
  current_price_cny: number | null  // 人民币价格（港股换算后）
  change_pct: number | null
  market_value: number | null
  market_value_cny: number | null  // 人民币市值
  pnl: number | null
  pnl_pct: number | null
  net_pnl?: number | null        // 净盈亏（人民币，含费口径：市值 - 含买入费成本 - 预估卖出费）
  net_pnl_pct?: number | null    // 净盈亏 %（与币种无关）
  net_cost_price?: number | null // 含费成本价（原币种，≈券商 App 的"成本价"）
  est_fees_cny?: number | null   // 预估费用合计（人民币：买入已付 + 卖出预估）
  daily_pnl: number | null
  daily_pnl_pct: number | null
  exchange_rate: number | null  // 汇率（仅港股）
  daily_move_status?: string
  quote_date?: string | null
}

export interface AccountSummary {
  id: number
  name: string
  available_funds: number
  total_market_value: number
  total_cost: number
  total_pnl: number
  total_pnl_pct: number
  total_net_pnl?: number | null
  total_net_pnl_pct?: number | null
  total_daily_pnl: number
  total_assets: number
  positions: Position[]
}

export interface PortfolioSummary {
  accounts: AccountSummary[]
  total: {
    total_market_value: number
    total_cost: number
    total_pnl: number
    total_pnl_pct: number
    total_net_pnl?: number | null
    total_net_pnl_pct?: number | null
    total_daily_pnl: number
    available_funds: number
    total_assets: number
  }
  exchange_rates?: {
    HKD_CNY: number
    USD_CNY?: number
  }
  fee_profiles?: Record<string, FeeProfile>
  quotes?: Record<string, { current_price: number | null; change_pct: number | null }>
}

export const toQuoteMap = (rows: QuoteResponse[]): Record<string, DisplayQuote> => {
  const map: Record<string, DisplayQuote> = {}
  for (const item of rows || []) {
    map[`${item.market}:${item.symbol}`] = {
      current_price: item.current_price ?? null,
      change_pct: item.change_pct ?? null,
      daily_move_status: item.daily_move_status,
      quote_date: item.quote_date,
    }
  }
  return map
}

const round2 = (value: number) => Math.round(value * 100) / 100

export const mergePortfolioQuotes = (
  portfolio: PortfolioSummary | null,
  quotes: Record<string, DisplayQuote>
): PortfolioSummary | null => {
  if (!portfolio) return null

  const hkdRate = portfolio.exchange_rates?.HKD_CNY ?? 0.92
  const usdRate = portfolio.exchange_rates?.USD_CNY ?? 7.25

  let grandMarketValue = 0
  let grandCost = 0
  let grandAvailable = 0
  let grandDailyPnl = 0
  let grandNetPnl = 0
  let grandNetCost = 0

  const accounts = portfolio.accounts.map(account => {
    let accMarketValue = 0
    let accCost = 0
    let accDailyPnl = 0
    let accNetPnl = 0
    let accNetCost = 0

    const positions = account.positions.map(pos => {
      const quote = quotes[`${pos.market}:${pos.symbol}`]
      const current_price = quote?.current_price ?? pos.current_price ?? null
      const daily_move_status = quote ? quote.daily_move_status : pos.daily_move_status
      const inactive = daily_move_status != null && daily_move_status !== 'current'
      // An explicit null from the latest quote must not resurrect an older daily change.
      const change_pct = inactive ? null : quote ? quote.change_pct : pos.change_pct ?? null
      const rate = pos.market === 'HK' ? hkdRate : pos.market === 'US' ? usdRate : 1

      const cost = pos.cost_price * pos.quantity * rate
      accCost += cost

      let market_value: number | null = null
      let market_value_cny: number | null = null
      let pnl: number | null = null
      let pnl_pct: number | null = null
      let daily_pnl: number | null = null
      let daily_pnl_pct: number | null = null
      let net_pnl: number | null = null
      let net_pnl_pct: number | null = null
      let net_cost_price: number | null = null
      let est_fees_cny: number | null = null

      if (current_price != null) {
        market_value = current_price * pos.quantity
        market_value_cny = market_value * rate
        accMarketValue += market_value_cny
        pnl = market_value_cny - cost
        pnl_pct = cost > 0 ? (pnl / cost * 100) : 0

        // 净盈亏(含费口径): 与毛盈亏同源按实时价重算, 保证两列口径一致
        const profile = portfolio.fee_profiles?.[pos.market] ?? DEFAULT_FEE_PROFILES[pos.market] ?? DEFAULT_FEE_PROFILES.CN
        const net = computeNetPnl(pos.cost_price, pos.quantity, current_price, profile)
        net_pnl = round2(net.net_pnl * rate)
        net_pnl_pct = round2(net.net_pnl_pct)
        net_cost_price = round2(net.net_cost_price)
        est_fees_cny = round2(net.total_fees * rate)
        accNetPnl += net.net_pnl * rate
        accNetCost += net.net_cost * rate
      }

      if (daily_move_status === 'closed' || daily_move_status === 'pre_market') {
        daily_pnl = 0
      } else if (current_price != null && change_pct != null && change_pct !== -100) {
        const prev = current_price / (1 + change_pct / 100)
        if (isFinite(prev) && prev > 0) {
          daily_pnl = round2((current_price - prev) * pos.quantity * rate)
          daily_pnl_pct = round2(change_pct)
          accDailyPnl += daily_pnl
        }
      }

      return {
        ...pos,
        current_price,
        current_price_cny: current_price != null ? current_price * rate : null,
        change_pct,
        market_value,
        market_value_cny,
        pnl,
        pnl_pct,
        daily_pnl,
        daily_pnl_pct,
        net_pnl,
        net_pnl_pct,
        net_cost_price,
        est_fees_cny,
        daily_move_status,
        quote_date: quote ? quote.quote_date : pos.quote_date,
        exchange_rate: pos.market === 'HK' || pos.market === 'US' ? rate : null,
      }
    })

    const accPnl = accMarketValue - accCost
    const accPnlPct = accCost > 0 ? (accPnl / accCost * 100) : 0
    const accTotalAssets = accMarketValue + account.available_funds

    grandMarketValue += accMarketValue
    grandCost += accCost
    grandAvailable += account.available_funds
    grandDailyPnl += accDailyPnl
    grandNetPnl += accNetPnl
    grandNetCost += accNetCost

    return {
      ...account,
      total_market_value: round2(accMarketValue),
      total_cost: round2(accCost),
      total_pnl: round2(accPnl),
      total_pnl_pct: round2(accPnlPct),
      total_net_pnl: round2(accNetPnl),
      total_net_pnl_pct: round2(accNetCost > 0 ? (accNetPnl / accNetCost * 100) : 0),
      total_daily_pnl: round2(accDailyPnl),
      total_assets: round2(accTotalAssets),
      positions,
    }
  })

  const grandPnl = grandMarketValue - grandCost
  const grandPnlPct = grandCost > 0 ? (grandPnl / grandCost * 100) : 0
  const grandTotalAssets = grandMarketValue + grandAvailable

  return {
    ...portfolio,
    accounts,
    total: {
      total_market_value: round2(grandMarketValue),
      total_cost: round2(grandCost),
      total_pnl: round2(grandPnl),
      total_pnl_pct: round2(grandPnlPct),
      total_net_pnl: round2(grandNetPnl),
      total_net_pnl_pct: round2(grandNetCost > 0 ? (grandNetPnl / grandNetCost * 100) : 0),
      total_daily_pnl: round2(grandDailyPnl),
      available_funds: round2(grandAvailable),
      total_assets: round2(grandTotalAssets),
    },
  }
}


export const applyMarketStatuses = (
  quotes: Record<string, DisplayQuote>,
  markets: { code: string; status: string; local_date?: string }[],
): Record<string, DisplayQuote> => {
  const statuses = new Map(markets.map(market => [market.code, market]))
  return Object.fromEntries(Object.entries(quotes).map(([key, quote]) => {
    const market = statuses.get(key.split(':')[0])
    if (!market) return [key, quote]
    const inactive = ['closed', 'pre_market', 'unknown'].includes(market.status)
    const stale = quote.quote_date && market.local_date && quote.quote_date !== market.local_date
    return [key, inactive || stale ? {
      ...quote, change_pct: null, daily_move_status: inactive ? market.status : 'stale',
    } : quote]
  }))
}
