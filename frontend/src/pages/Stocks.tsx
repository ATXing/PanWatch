import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Trash2, Pencil, Search, X, TrendingUp, Bot, Play, RefreshCw, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight, Building2, ChevronDown, ChevronRight, Cpu, Bell, Clock, Newspaper, ExternalLink, BarChart3, Brain, Eye, EyeOff } from 'lucide-react'
import { fetchAPI, stocksApi, insightApi, tradingAgentsApi, type AIService, type NotifyChannel, type UziListItem } from '@panwatch/api'
import { klinesApi } from '@panwatch/api/klines'
import { useLocalStorage } from '@/lib/utils'
import {
  buildPortfolioStockKeys,
  loadPortfolioPageBackgroundData,
  loadPortfolioPageCoreData,
  loadPortfolioPageQuoteData,
} from '@/lib/portfolio-page-data'
import { SuggestionBadge, formatShortInstant, type SuggestionInfo, type KlineSummary } from '@panwatch/biz-ui/components/suggestion-badge'
import { buildTaInfo, taConfidenceText, taToneCls, type TaInfo } from '@/lib/ta-badge'
import { KlineSummaryDialog } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import { Skeleton } from '@panwatch/base-ui/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@panwatch/base-ui/components/ui/dialog'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectLabel, SelectItem } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import StockInsightModal from '@panwatch/biz-ui/components/stock-insight-modal'
import { DeepAnalysisModal } from '@panwatch/biz-ui/components/deep-analysis-modal'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import { StockNoteButton } from '@panwatch/biz-ui/components/stock-note'
import { useTranslation } from 'react-i18next'
import { localizeAgentDescription, localizeAgentName } from '@/i18n/agent-labels'
import { getCurrentLocale } from '@/i18n'
import { browserTimezone } from '@panwatch/base-ui'
import { applyMarketStatuses, mergePortfolioQuotes, toQuoteMap, type Position, type PortfolioSummary, type QuoteResponse, type DisplayQuote } from '@/lib/portfolio-quotes'
import { MarketCalendarStatus, type MarketStatus } from '@/components/MarketCalendarStatus'
import { ThsLink } from '@/components/ThsLink'
import { marketSignTextClass } from '@/lib/market-colors'
import { parseAssistantPortfolioTarget } from '@/lib/assistant-navigation'
import { useGuidedTour } from '@/components/onboarding/GuidedTour'
import FirstAnalysis from '@/components/onboarding/FirstAnalysis'
import type { AgentResult, StockAgentInfo, Stock, Account, AgentConfig, SchedulePreview, SearchResult, QuoteRequestItem, StockForm, AccountForm, PositionForm, PoolSuggestion, NewsItem, PriceAlertRuleSummary } from '@/components/portfolio/types'
import { AccountDialog } from '@/components/portfolio/AccountDialog'
import { NewsDialog } from '@/components/portfolio/NewsDialog'
import { PositionDialog } from '@/components/portfolio/PositionDialog'
import { useQuoteRefresh } from '@/hooks/useQuoteRefresh'

/**
 * 股票名后的「UZI xx」标签:只有做过 UZI 调研的股票才有,点击直接进 UZI 调研 tab。
 * UZI 是排雷/尽调结论,不是涨跌信号,故不用红绿配色(避免与涨跌语义混淆)。
 */
function UziTag({ info, onOpen }: { info: UziListItem; onOpen: () => void }) {
  // 只用实测口径分：UZI 原分把占位分/未采集的默认分一起加权，挂到列表上会误导
  const score = info.trusted && typeof info.real_score === 'number' ? info.real_score : null
  const toneCls =
    score == null
      ? 'bg-accent text-muted-foreground border-border'
      : score >= 70
        ? 'bg-violet-500/20 text-violet-700 dark:text-violet-200 border-violet-500/50'
        : score >= 60
          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-500/40'
          : 'bg-amber-500/20 text-amber-700 dark:text-amber-200 border-amber-500/50'
  const fmtDate = (d?: string) =>
    d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || ''
  const brief = (info.one_liner || '').split('\n')[0].replace(/🟢\s*/g, '').trim()
  // 报告真正落盘的时刻（后端取报告目录 mtime，不是「最后一次同步」时间）
  const reportTime = formatShortInstant(info.report_time)
  const tip = [
    `UZI 调研${info.tier ? ` · ${info.tier} 档` : ''}${info.as_of_date ? ` · ${fmtDate(info.as_of_date)}` : ''}`,
    reportTime ? `报告产出 ${reportTime}` : '',
    score != null
      ? `实测口径 ${score.toFixed(1)} 分（${info.real_dims ?? '?'}/${info.total_dims ?? '?'} 维有真实数据，覆盖权重 ${Number(
          info.real_weight_pct ?? 0
        ).toFixed(0)}%）`
      : `数据不足，未评分（${info.real_dims ?? 0}/${info.total_dims ?? '?'} 维有真实数据）`,
    info.fundamental_score != null ? `UZI 基本面分 ${info.fundamental_score}（19 维全加权，含占位/默认分，仅供参考）` : '',
    brief,
    '点击进入 UZI 调研结果页',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    // 时间放在框外下方，跟 AI 建议/指标徽章的「徽章 + 下方时间」排版保持一致；
    // align-bottom 让整块贴行底，同一行里几个徽章的「框下时间」才会在同一底线
    <span className="shrink-0 align-bottom ml-2 mr-2 inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        title={tip}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpen()
        }}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-semibold leading-none shadow-sm transition-all hover:shadow hover:brightness-105 ${toneCls}`}
      >
        <span className="opacity-75 tracking-wide">UZI</span>
        {score != null && <span className="font-mono tabular-nums">{score.toFixed(1)}</span>}
      </button>
      {reportTime && (
        <span className="text-[10px] font-normal leading-none text-muted-foreground/70 tabular-nums">{reportTime}</span>
      )}
    </span>
  )
}

/**
 * 没做过 UZI 调研的股票：给一个入口标签，点进去直接落在弹窗的 UZI tab 上发起调研。
 * 样式刻意比「有报告」的 UziTag 低调（虚线 + 无底色），避免跟已有结论抢视觉。
 */
function UziEmptyTag({ onOpen }: { onOpen: () => void }) {
  return (
    <span className="shrink-0 align-bottom ml-2 mr-2 inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        title={'这只股票还没做过 UZI 调研\n点击进入 UZI 面板，可一键发起调研（排雷/尽调，非买卖信号）'}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpen()
        }}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-transparent px-2 py-1.5 text-[12px] font-medium leading-none text-muted-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
      >
        <span className="opacity-70 tracking-wide">UZI</span>
        <span>评估</span>
      </button>
      {/* 占位行：与 UziTag 时间行等高，同排徽章的框底才能落在同一水平线 */}
      <span aria-hidden className="invisible text-[10px] leading-none">
        00/00 00:00
      </span>
    </span>
  )
}

/**
 * 股票名后的「TA 评级」标签：做过 TradingAgents 深度分析的股票才有。
 * 点开复用 🧠 按钮的 DeepAnalysisModal；与 UZI 徽章同构（26px 框 + 框下时间）。
 * TA 是买卖决策，允许用涨跌色语义（沿用项目 market-up/down），与 UZI 的中性紫区分开。
 */
function TaTag({ info, onOpen }: { info: TaInfo; onOpen: () => void }) {
  const review = info.review_required === true || info.rating_raw === 'review'
  const label = review ? '待复核' : info.action_label || '—'
  const conf = typeof info.confidence === 'number' ? info.confidence.toFixed(1) : null
  // 徽章内写「· 置信度7.2」（与 AI 徽章的「·置信度72」同一套读法），裸数字看不出含义
  const confText = taConfidenceText(info.confidence)
  const when = formatShortInstant(info.generated_at || info.analysis_date)
  const dateText = info.analysis_date || ''
  const tip = [
    `TradingAgents 深度分析${dateText ? ` · ${dateText}` : ''}`,
    when ? `生成 ${when}` : '',
    `评级 ${info.rating_raw || info.action}${review ? '（待人工复核）' : ''}`,
    conf != null ? `置信度 ${conf} / 10` : '',
    info.one_liner,
    '点击进入深度分析（可重新分析 / 查看完整报告）',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <span className="shrink-0 align-bottom ml-2 mr-2 inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        title={tip}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpen()
        }}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] font-semibold leading-none shadow-sm transition-all hover:shadow hover:brightness-105 ${taToneCls(info.action, review)}`}
      >
        <span className="opacity-75 tracking-wide">TA</span>
        <span>{label}</span>
        {confText && <span className="font-normal tabular-nums opacity-80 whitespace-nowrap">{confText}</span>}
      </button>
      {when && (
        <span className="text-[10px] font-normal leading-none text-muted-foreground/70 tabular-nums">{when}</span>
      )}
    </span>
  )
}

/**
 * 没做过 TradingAgents 深度分析的股票：给一个虚线入口，点开直接进弹窗发起分析。
 * 样式刻意比 TaTag 低调（虚线 + 无底色），避免与已有结论抢视觉。
 */
function TaEmptyTag({ onOpen }: { onOpen: () => void }) {
  return (
    <span className="shrink-0 align-bottom ml-2 mr-2 inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        title={'这只股票还没做过 TradingAgents 深度分析\n点击进入深度分析面板，可一键发起（多 Agent 投研，非买卖建议）'}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onOpen()
        }}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-transparent px-2 py-1.5 text-[12px] font-medium leading-none text-muted-foreground/80 transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
      >
        <span className="opacity-70 tracking-wide">TA</span>
        <span>分析</span>
      </button>
      {/* 占位行：与 TaTag 时间行等高，同排徽章的框底才能落在同一水平线 */}
      <span aria-hidden className="invisible text-[10px] leading-none">
        00/00 00:00
      </span>
    </span>
  )
}

/**
 * 名字这一格刻意跟「徽章栈」同构：上面一行 26px 高（与 UZI / AI / 指标徽章框等高）+ 下面一条隐形时间行。
 * 因为各栈总高一致，父容器无论是「行内流 + align-bottom」（桌面表格）还是「flex items-center」（卡片），
 * 结果都是**框**对**框**：股票名与徽章框垂直居中对齐，框下的时间戳在框外、不参与这个居中。
 */
function NameRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`align-bottom inline-flex flex-col items-start gap-0.5 ${className}`}>
      <span className="inline-flex min-h-[26px] items-center gap-1.5">{children}</span>
      <span aria-hidden className="invisible text-[10px] leading-none">00/00 00:00</span>
    </span>
  )
}

const emptyStockForm: StockForm = { symbol: '', name: '', market: 'CN', asset_type: 'stock' }
const emptyAccountForm: AccountForm = { name: '', available_funds: '0' }

const buildQuoteItemsFrom = (stockList: Stock[], portfolio: PortfolioSummary | null): QuoteRequestItem[] => {
  const items: QuoteRequestItem[] = []
  const seen = new Set<string>()
  const add = (symbol: string, market: string) => {
    const key = `${market}:${symbol}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ symbol, market })
  }

  for (const stock of stockList) add(stock.symbol, stock.market)
  for (const account of portfolio?.accounts || []) {
    for (const pos of account.positions) add(pos.symbol, pos.market)
  }
  return items
}


const toPriceAlertSummaryMap = (rows: PriceAlertRuleSummary[]): Record<string, { total: number; enabled: number }> => {
  const map: Record<string, { total: number; enabled: number }> = {}
  for (const row of rows || []) {
    const key = `${String(row.market || 'CN').toUpperCase()}:${String(row.stock_symbol || '').toUpperCase()}`
    if (!map[key]) map[key] = { total: 0, enabled: 0 }
    map[key].total += 1
    if (row.enabled) map[key].enabled += 1
  }
  return map
}


export default function StocksPage() {
  const tour = useGuidedTour()
  const tourQuoteBusy = useRef(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation('configuration')
  const confirmAction = useConfirm()
  const stockT = t as unknown as (key: string, options?: Record<string, unknown>) => string
  const agentName = (name: string, fallback?: string) => localizeAgentName(name, fallback, stockT)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [services, setServices] = useState<AIService[]>([])
  const [channels, setChannels] = useState<NotifyChannel[]>([])
  const [loading, setLoading] = useState(true)

  // Portfolio
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [portfolioRaw, setPortfolioRaw] = useState<PortfolioSummary | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set())

  // Quotes for all stocks (used in stock list)
  const [quotes, setQuotes] = useState<Record<string, DisplayQuote>>({})
  const [quotesLoading, setQuotesLoading] = useState(false)
  // Keyed by `${market}:${symbol}` to avoid cross-market symbol collisions
  const [klineSummaries, setKlineSummaries] = useState<Record<string, KlineSummary>>({})

  // Auto-refresh (持久化到 localStorage)
  const [autoRefresh, setAutoRefresh] = useLocalStorage('panwatch_stocks_autoRefresh', false)
  const [refreshInterval, setRefreshInterval] = useLocalStorage('panwatch_stocks_refreshInterval', 30)
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null)

  type ViewTab = 'positions' | 'watchlist'
  const [savedViewTab, setViewTab] = useLocalStorage<ViewTab>('panwatch_stocks_viewTab', 'positions')
  // 隐私开关：隐藏上方汇总卡金额（真实数字不渲染进 DOM，截图/复制安全）
  const [privacyHidden, setPrivacyHidden] = useLocalStorage('panwatch_stocks_privacyHidden', false)

  // 建议池建议（来自 /suggestions API）
  const [poolSuggestions, setPoolSuggestions] = useState<Record<string, PoolSuggestion>>({})
  const [priceAlertSummaryMap, setPriceAlertSummaryMap] = useState<Record<string, { total: number; enabled: number }>>({})

  // News Dialog
  const [newsDialogOpen, setNewsDialogOpen] = useState(false)
  const [newsDialogSymbol, setNewsDialogSymbol] = useState<string>('')  // 空=全部, 否则=指定股票
  const [news, setNews] = useState<NewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)

  // Kline Dialog
  const [klineDialogOpen, setKlineDialogOpen] = useState(false)
  const [klineDialogSymbol, setKlineDialogSymbol] = useState('')
  const [klineDialogMarket, setKlineDialogMarket] = useState('CN')
  const [klineDialogName, setKlineDialogName] = useState<string | undefined>(undefined)
  const [klineDialogHasPosition, setKlineDialogHasPosition] = useState<boolean>(false)
  const [klineDialogInitialSummary, setKlineDialogInitialSummary] = useState<KlineSummary | null>(null)
  const [insightOpen, setInsightOpen] = useState(false)
  const [insightSymbol, setInsightSymbol] = useState('')
  const [insightMarket, setInsightMarket] = useState('CN')
  const [insightName, setInsightName] = useState<string | undefined>(undefined)
  const [insightHasPosition, setInsightHasPosition] = useState(false)
  // 打开洞察弹窗时直接落在哪个 tab(从列表「UZI xx」标签一键进来用)
  const [insightInitialTab, setInsightInitialTab] = useState<'uzi' | undefined>(undefined)
  // UZI 调研摘要:key = `${symbol}|${market}`,一次拉全量,不在每行单独请求
  const [uziMap, setUziMap] = useState<Record<string, UziListItem>>({})
  // TradingAgents 深度分析摘要:key = symbol(analysis_history 只按 stock_symbol 存)。
  // null = 已确认没有报告(渲染空标签);缺键 = 未取到/请求失败(该行不渲染,避免误报「没分析过」)
  const [taMap, setTaMap] = useState<Record<string, TaInfo | null>>({})
  // 记录当前 taMap 对应的是哪一组 symbol(排序后拼接),避免行情刷新时 portfolio 对象变化触发反复全量重拉、
  // 也避免首屏在数据未到时把所有行先闪成空标签
  const [taLoadedKey, setTaLoadedKey] = useState<string | null>(null)

  // Market status
  const [marketStatus, setMarketStatus] = useState<MarketStatus[]>([])
  const marketStatusRef = useRef<MarketStatus[]>([])
  const previousMarketStatusRef = useRef<MarketStatus[]>([])
  marketStatusRef.current = marketStatus
  // Guard to prevent overlapping K线刷新任务导致实际并发超限
  const klineRefreshInFlight = useRef<Promise<void> | null>(null)
  const initialLoadPromiseRef = useRef<Promise<void> | null>(null)
  const configLoadPromiseRef = useRef<Promise<void> | null>(null)
  const configLoadedRef = useRef(false)

  // Stock form
  const [showStockForm, setShowStockForm] = useState(false)
  const [stockForm, setStockForm] = useState<StockForm>(emptyStockForm)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMarket, setSearchMarket] = useState('')  // 搜索市场筛选
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [refreshingStockList, setRefreshingStockList] = useState(false)

  // Account form
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [accountForm, setAccountForm] = useState<AccountForm>(emptyAccountForm)
  const [editAccountId, setEditAccountId] = useState<number | null>(null)

  // Position form
  const [positionDialogOpen, setPositionDialogOpen] = useState(false)
  const [positionForm, setPositionForm] = useState<PositionForm>({ account_id: 0, stock_id: 0, cost_price: '', quantity: '', invested_amount: '', trading_style: '', stock_symbol: '', stock_name: '', stock_market: 'CN', stock_asset_type: 'stock' })
  const [editPositionId, setEditPositionId] = useState<number | null>(null)
  const [positionDialogAccountId, setPositionDialogAccountId] = useState<number | null>(null)
  const [positionSearchQuery, setPositionSearchQuery] = useState('')
  const [positionSearchMarket, setPositionSearchMarket] = useState('')  // 搜索市场筛选
  const [positionSearchResults, setPositionSearchResults] = useState<SearchResult[]>([])
  const [positionSearching, setPositionSearching] = useState(false)
  const [showPositionDropdown, setShowPositionDropdown] = useState(false)
  const positionSearchTimer = useRef<ReturnType<typeof setTimeout>>()
  const positionDropdownRef = useRef<HTMLDivElement>(null)

  // Agent dialog
  const [agentDialogStock, setAgentDialogStock] = useState<Stock | null>(null)

  // 深度分析(TradingAgents)弹窗
  const [deepAnalysisTarget, setDeepAnalysisTarget] = useState<{
    stockId: number
    symbol: string
    name: string
  } | null>(null)
  const openDeepAnalysis = useCallback((stockId: number, symbol: string, name: string) => {
    setDeepAnalysisTarget({ stockId, symbol, name })
  }, [])
  const [triggeringAgent, setTriggeringAgent] = useState<string | null>(null)
  const [schedulePreviewCache, setSchedulePreviewCache] = useState<Record<string, SchedulePreview | { error: string }>>({})
  const [schedulePreviewLoading, setSchedulePreviewLoading] = useState<Record<string, boolean>>({})
  // 运行中的单只股票 Agent（按股票标记具体 Agent 名称）
  const [runningAgents, setRunningAgents] = useState<Record<number, string | null>>({})
  const [agentResultDialog, setAgentResultDialog] = useState<{ title: string; content: string; should_alert: boolean; notified: boolean } | null>(null)

  // Stock list filter
  const [stockListFilter, setStockListFilter] = useState('')  // '' = 全部, 'CN' = A股, 'HK' = 港股, 'US' = 美股
  // 持仓页的市场筛选。关注页过滤掉持仓股后，持仓页是唯一能看全部持仓的地方；
  // 而账户只有一个、A股与港股混放，没有市场维度就做不到「只看港股持仓」。
  const [positionMarketFilter, setPositionMarketFilter] = useState('')
  const viewTab = tour?.active && ['stock', 'quote', 'analysis'].includes(tour.step || '') ? 'watchlist' : savedViewTab
  useEffect(() => {
    if (!tour?.active || !['stock', 'quote', 'analysis'].includes(tour.step || '')) return
    setStockListFilter('')
  }, [tour?.active, tour?.step])
  const [watchlistOnlyAlerts, setWatchlistOnlyAlerts] = useLocalStorage<boolean>('panwatch_watchlist_only_alerts', false)

  // Remove watchlist modal
  const [removeWatchStock, setRemoveWatchStock] = useState<Stock | null>(null)
  const [removingWatchStock, setRemovingWatchStock] = useState(false)
  const [draggingWatchStockId, setDraggingWatchStockId] = useState<number | null>(null)
  const [draggingPositionId, setDraggingPositionId] = useState<number | null>(null)
  const [draggingPositionAccountId, setDraggingPositionAccountId] = useState<number | null>(null)
  const watchDragSnapshotRef = useRef<Stock[] | null>(null)
  const positionDragSnapshotRef = useRef<PortfolioSummary | null>(null)

  const { toast } = useToast()

  const moveById = <T extends { id: number }>(list: T[], fromId: number, toId: number): T[] => {
    const fromIdx = list.findIndex(x => x.id === fromId)
    const toIdx = list.findIndex(x => x.id === toId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return list
    const next = [...list]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    return next
  }

  const persistWatchlistOrder = useCallback(async (ordered: Stock[]) => {
    const payload = ordered.map((s, idx) => ({ id: s.id, sort_order: idx + 1 }))
    await fetchAPI('/stocks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewWatchlistReorder = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return
    setStocks(prev => {
      const ordered = [...prev].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
      const moved = moveById(ordered, fromId, toId)
      return moved.map((s, idx) => ({ ...s, sort_order: idx + 1 }))
    })
  }, [])

  const commitWatchlistReorder = useCallback(async () => {
    const current = stocks
    if (!current || current.length === 0) return
    try {
      await persistWatchlistOrder(current)
    } catch (e) {
      if (watchDragSnapshotRef.current) setStocks(watchDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.saveWatchOrderFailed'), 'error')
    }
  }, [persistWatchlistOrder, stocks, toast])

  const persistPositionOrder = useCallback(async (ordered: Position[]) => {
    const payload = ordered.map((p, idx) => ({ id: p.id, sort_order: idx + 1 }))
    await fetchAPI('/positions/reorder/batch', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewPositionReorder = useCallback((accountId: number, fromId: number, toId: number) => {
    if (fromId === toId) return
    setPortfolioRaw(prev => {
      if (!prev) return prev
      const accountsNext = prev.accounts.map(acc => {
        if (acc.id !== accountId) return acc
        const moved = moveById(acc.positions || [], fromId, toId).map((p, idx) => ({ ...p, sort_order: idx + 1 }))
        return { ...acc, positions: moved }
      })
      return { ...prev, accounts: accountsNext }
    })
  }, [])

  const commitPositionReorder = useCallback(async (accountId: number) => {
    const acc = portfolioRaw?.accounts?.find(a => a.id === accountId)
    const ordered = acc?.positions || []
    if (!ordered.length) return
    try {
      await persistPositionOrder(ordered)
    } catch (e) {
      if (positionDragSnapshotRef.current) setPortfolioRaw(positionDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.savePositionOrderFailed'), 'error')
    }
  }, [persistPositionOrder, portfolioRaw, toast])

  const isSuppressCardClick = () => {
    try {
      const until = (window as any).__panwatch_suppress_card_click_until
      return typeof until === 'number' && Date.now() < until
    } catch {
      return false
    }
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 备注保存成功后就地回写 stocks，避免整页重新拉取（同改 asset_type 的做法）
  const handleStockNoteSaved = useCallback((stockId: number, note: string) => {
    setStocks(previous => previous.map(s => (s.id === stockId ? { ...s, note } : s)))
  }, [])

  const buildQuoteItems = useCallback((): QuoteRequestItem[] => {
    return buildQuoteItemsFrom(stocks, portfolioRaw)
  }, [stocks, portfolioRaw])

  const requestQuotes = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<QuoteResponse[]> => {
    if (items.length === 0) return []
    try {
      return await fetchAPI<QuoteResponse[]>('/quotes/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
        signal,
      })
    } catch (e) {
      console.warn('刷新行情失败:', e)
      return []
    }
  }, [])

  const requestSuggestions = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<Record<string, PoolSuggestion>> => {
    if (items.length === 0) return {}
    try {
      const params = new URLSearchParams({
        include_expired: 'true',
        stock_keys: buildPortfolioStockKeys(items),
      })
      return await fetchAPI<Record<string, PoolSuggestion>>(`/suggestions?${params.toString()}`, { signal })
    } catch (e) {
      console.warn('加载建议池失败:', e)
      return {}
    }
  }, [])

  const requestPriceAlerts = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<PriceAlertRuleSummary[]> => {
    if (items.length === 0) return []
    try {
      return await fetchAPI<PriceAlertRuleSummary[]>('/price-alerts', { signal })
    } catch (e) {
      console.warn('加载提醒摘要失败:', e)
      return []
    }
  }, [])

  const requestKlineSummaries = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<Record<string, KlineSummary>> => {
    if (items.length === 0) return {}
    try {
      const data = await klinesApi.summaryBatch(items, signal)
      const map: Record<string, KlineSummary> = {}
      for (const item of data || []) {
        if (item && item.summary && !('error' in item.summary)) {
          map[`${item.market}:${item.symbol}`] = item.summary as unknown as KlineSummary
        }
      }
      return map
    } catch {
      // 批量请求失败时保留旧摘要，避免技术徽章整体闪断。
      return {}
    }
  }, [])

  const loadNewStockSummary = useCallback(async (item: QuoteRequestItem) => {
    const map = await requestKlineSummaries([item])
    setKlineSummaries(prev => ({ ...prev, ...map }))
  }, [requestKlineSummaries])

  const refreshMarketStatus = useCallback(async (signal?: AbortSignal): Promise<MarketStatus[]> => {
    try {
      const data = await fetchAPI<MarketStatus[]>('/stocks/markets/status', { signal })
      if (!signal?.aborted) setMarketStatus(data)
      return data
    } catch (error) {
      if (!signal?.aborted) console.warn('获取市场状态失败:', error)
      return []
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => { if (!document.hidden) void refreshMarketStatus(controller.signal) }
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshMarketStatus])

  const refreshQuotes = useCallback(async (automatic = false, signal?: AbortSignal) => {
    const statuses = marketStatusRef.current
    const items = buildQuoteItems().filter(item => !automatic ||
      !statuses.some(status => status.code === item.market) ||
      statuses.some(status => status.code === item.market && status.is_trading))
    if (items.length === 0) return

    setQuotesLoading(true)
    try {
      const data = await requestQuotes(items, signal)
      if (!signal?.aborted && data.length > 0) {
        setQuotes(previous => ({ ...previous, ...toQuoteMap(data) }))
        setLastRefreshTime(new Date())
      }
    } finally {
      setQuotesLoading(false)
    }
  }, [buildQuoteItems, requestQuotes])

  useEffect(() => {
    if (!portfolioRaw) return
    setPortfolio(mergePortfolioQuotes(portfolioRaw, applyMarketStatuses(quotes, marketStatus)))
  }, [portfolioRaw, quotes, marketStatus])

  // 刷新 K 线摘要（批量接口）；并防止重入
  const refreshKlines = useCallback(async () => {
    if (klineRefreshInFlight.current) return klineRefreshInFlight.current
    const run = (async () => {
      const items = buildQuoteItems()
      if (items.length === 0) return
      const map = await requestKlineSummaries(items)
      // 增量合并：本轮单只失败时保留旧值，避免技术徽章闪断/消失
      setKlineSummaries(prev => ({ ...prev, ...map }))
    })()
    klineRefreshInFlight.current = run
    try { await run } finally { klineRefreshInFlight.current = null }
  }, [buildQuoteItems, requestKlineSummaries])

  // Fetch the closing snapshot once, then stop polling closed-market quotes.
  useEffect(() => {
    const previous = previousMarketStatusRef.current
    previousMarketStatusRef.current = marketStatus
    if (autoRefresh && marketStatus.some(market => market.status === 'after_hours' &&
      previous.some(old => old.code === market.code && old.is_trading))) void refreshQuotes()
  }, [marketStatus, autoRefresh, refreshQuotes])

  // 从建议池加载建议（包含历史建议和多来源建议）
  const loadPoolSuggestions = useCallback(async (itemsOverride?: QuoteRequestItem[]) => {
    const data = await requestSuggestions(itemsOverride || buildQuoteItems())
    setPoolSuggestions(data)
  }, [buildQuoteItems, requestSuggestions])

  const loadPriceAlertSummaries = useCallback(async () => {
    const rows = await requestPriceAlerts(buildQuoteItems())
    setPriceAlertSummaryMap(toPriceAlertSummaryMap(rows))
  }, [buildQuoteItems, requestPriceAlerts])

  const loadConfigAsync = useCallback((signal?: AbortSignal): Promise<void> => {
    if (configLoadedRef.current) return Promise.resolve()
    if (configLoadPromiseRef.current) return configLoadPromiseRef.current

    const run = (async () => {
      try {
        const [agentData, servicesData, channelsData] = await Promise.all([
          fetchAPI<AgentConfig[]>('/agents', { signal }),
          fetchAPI<AIService[]>('/providers/services', { signal }),
          fetchAPI<NotifyChannel[]>('/channels', { signal }),
        ])
        setAgents(agentData)
        setServices(servicesData)
        setChannels(channelsData)
        configLoadedRef.current = true
      } catch (e) {
        console.warn('加载配置数据失败:', e)
      }
    })()
    configLoadPromiseRef.current = run
    void run.finally(() => {
      configLoadPromiseRef.current = null
    })
    return run
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const stockData = await fetchAPI<Stock[]>('/stocks', { signal })
      setStocks(stockData)
    } catch (e) {
      if (!signal?.aborted) console.error(e)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  const loadPortfolio = useCallback(async () => {
    try {
      // Mutation refresh is local metadata only; render using the quotes already on screen.
      const portfolioData = await fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false&refresh_exchange_rates=false')
      setPortfolioRaw(portfolioData)
      setAccounts(portfolioData.accounts.map(account => ({
        id: account.id,
        name: account.name,
        available_funds: account.available_funds,
        enabled: true,
      })))
      setExpandedAccounts(prev => new Set([...prev, ...portfolioData.accounts.map(account => account.id)]))
      setPortfolio(mergePortfolioQuotes(portfolioData, quotes))

      // New symbols may need a quote; cost/quantity/account edits need no market-data fetch.
      const missing = buildQuoteItemsFrom(stocks, portfolioData).filter(item => !quotes[`${item.market}:${item.symbol}`])
      if (missing.length > 0) {
        void requestQuotes(missing).then(rows => {
          setQuotes(prev => ({ ...prev, ...toQuoteMap(rows) }))
        })
      }
    } catch (e) {
      console.error(e)
    }
  }, [requestQuotes, quotes, stocks])

  const loadInitialData = useCallback((signal: AbortSignal): Promise<void> => {
    if (initialLoadPromiseRef.current) return initialLoadPromiseRef.current
    setLoading(true)
    setPortfolioLoading(true)

    const run = (async () => {
      const coreData = await loadPortfolioPageCoreData({
        loadStocks: requestSignal => fetchAPI<Stock[]>('/stocks', { signal: requestSignal }),
        loadPortfolio: requestSignal => fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false&refresh_exchange_rates=false', { signal: requestSignal }),
      }, signal)

      if (signal.aborted) return

      // Publish local metadata immediately; market-data lanes update independently.
      const quoteMap: Record<string, QuoteResponse> = {}
      setStocks(coreData.stocks)
      setPortfolioRaw(coreData.portfolio)
      setQuotes(quoteMap)
      setKlineSummaries({})
      setPoolSuggestions({})
      setPriceAlertSummaryMap({})
      setPortfolio(mergePortfolioQuotes(coreData.portfolio, quoteMap))
      const nextAccounts = coreData.portfolio.accounts.map(account => ({
        id: account.id,
        name: account.name,
        available_funds: account.available_funds,
        enabled: true,
      }))
      setAccounts(nextAccounts)
      setExpandedAccounts(new Set(nextAccounts.map(account => account.id)))
      setLoading(false)
      setPortfolioLoading(false)

      void loadPortfolioPageQuoteData({
        buildQuoteItems: buildQuoteItemsFrom,
        loadQuotes: requestQuotes,
      }, coreData.stocks, coreData.portfolio, signal).then(data => {
        if (signal.aborted) return
        setQuotes(toQuoteMap(data.quotes))
        if (data.quotes.length > 0) setLastRefreshTime(new Date())
      }).catch(error => {
        if (!signal.aborted) console.warn('Portfolio quotes unavailable:', error)
      })

      // FX refresh also runs independently of the metadata shell and quotes.
      void fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false', { signal }).then(data => {
        if (!signal.aborted) setPortfolioRaw(previous => previous ? { ...previous, exchange_rates: data.exchange_rates } : previous)
      }).catch(error => {
        if (!signal.aborted) console.warn('Portfolio exchange rates unavailable:', error)
      })

      void loadPortfolioPageBackgroundData({
        loadMarketStatus: refreshMarketStatus,
        buildQuoteItems: buildQuoteItemsFrom,
        loadSuggestions: requestSuggestions,
        loadPriceAlerts: requestPriceAlerts,
        loadKlines: requestKlineSummaries,
      }, coreData.stocks, coreData.portfolio, signal, {
        klines: data => setKlineSummaries(prev => ({ ...prev, ...data })),
        suggestions: setPoolSuggestions,
        priceAlerts: data => setPriceAlertSummaryMap(toPriceAlertSummaryMap(data)),
      }).catch(error => {
        if (!signal.aborted) console.warn('加载持仓页后台数据失败:', error)
      })
    })().catch(error => {
      if (!signal.aborted) console.error('加载持仓页面数据失败:', error)
    }).finally(() => {
      if (!signal.aborted) { setLoading(false); setPortfolioLoading(false) }
      initialLoadPromiseRef.current = null
    })

    initialLoadPromiseRef.current = run
    return run
  }, [refreshMarketStatus, requestKlineSummaries, requestPriceAlerts, requestQuotes, requestSuggestions])

  // Load news for specific stock or all watchlist
  const loadNews = useCallback(async (stockName?: string) => {
    setNewsLoading(true)
    try {
      const params = new URLSearchParams({ hours: '168', limit: '50' })  // 7天
      if (stockName) {
        // 直接传递股票名称，比代码更稳定
        params.set('names', stockName)
      }
      const newsData = await fetchAPI<NewsItem[]>(`/news?${params}`)
      setNews(newsData)
    } catch (e) {
      console.error('加载新闻失败:', e)
    } finally {
      setNewsLoading(false)
    }
  }, [])

  const openKlineDialog = useCallback((symbol: string, market: string, name?: string, hasPosition?: boolean) => {
    setKlineDialogSymbol(symbol)
    setKlineDialogMarket(market || 'CN')
    setKlineDialogName(name)
    setKlineDialogHasPosition(!!hasPosition)
    const m = market || 'CN'
    setKlineDialogInitialSummary(klineSummaries[`${m}:${symbol}`] || null)
    setKlineDialogOpen(true)
  }, [klineSummaries])

  const handledAssistantTargetRef = useRef<string | null>(null)
  useEffect(() => {
    const target = parseAssistantPortfolioTarget(searchParams)
    if (!target) {
      handledAssistantTargetRef.current = null
      return
    }
    const key = `${target.market}:${target.symbol}`
    if (handledAssistantTargetRef.current === key) return
    handledAssistantTargetRef.current = key
    openKlineDialog(target.symbol, target.market)
    const next = new URLSearchParams(searchParams)
    next.delete('view')
    next.delete('symbol')
    next.delete('market')
    setSearchParams(next, { replace: true })
  }, [openKlineDialog, searchParams, setSearchParams])

  // Open news dialog - pass stock name for more stable search
  const openNewsDialog = useCallback((stockName?: string) => {
    setNewsDialogSymbol(stockName || '')  // 存储名称用于 UI 显示
    setNewsDialogOpen(true)
    loadNews(stockName)
  }, [loadNews])

  const openStockDetail = useCallback((stockSymbol: string, stockMarket: string, stockName?: string, hasPosition?: boolean) => {
    setInsightInitialTab(undefined)
    setInsightSymbol(stockSymbol)
    setInsightMarket(stockMarket || 'CN')
    setInsightName(stockName)
    setInsightHasPosition(!!hasPosition)
    setInsightOpen(true)
  }, [])

  // 点「UZI xx」标签:打开同一个洞察弹窗,直接落在 UZI 调研 tab
  const openUziReport = useCallback((stockSymbol: string, stockMarket: string, stockName?: string, hasPosition?: boolean) => {
    setInsightSymbol(stockSymbol)
    setInsightMarket(stockMarket || 'CN')
    setInsightName(stockName)
    setInsightHasPosition(!!hasPosition)
    setInsightInitialTab('uzi')
    setInsightOpen(true)
  }, [])

  // 拉一次 UZI 摘要(全量几十条,很轻),失败静默——没有标签不影响主流程
  const loadUziMap = useCallback(async () => {
    try {
      const r = await insightApi.uziList<{ count: number; items: UziListItem[] }>()
      const map: Record<string, UziListItem> = {}
      for (const it of r?.items || []) {
        map[`${it.symbol}|${it.market}`] = it
      }
      setUziMap(map)
    } catch {
      /* 忽略:UZI 端点不可用时列表照常工作 */
    }
  }, [])

  useEffect(() => {
    void loadUziMap()
  }, [loadUziMap])

  // —— TradingAgents 徽章:逐只拉最新结果(后端没有批量接口) ——
  // 没分析过的票只返回极小的 null;只有真分析过的少数票才回完整 JSON,并发 4 足够。
  // 用排序后的 symbol 串做稳定 key:行情刷新会替换 portfolio 对象,但 key 不变就不重拉。
  const taSymbolsKey = useMemo(() => {
    const symbols = new Set<string>()
    for (const account of portfolio?.accounts || []) {
      for (const pos of account.positions || []) if (pos.symbol) symbols.add(pos.symbol)
    }
    for (const stock of stocks) if (stock.symbol) symbols.add(stock.symbol)
    return Array.from(symbols).sort().join(',')
  }, [portfolio, stocks])

  // 加载期间 symbol 集合可能变化(持仓/关注刚加载完);用 ref 记住最新 key,
  // 只有「本次结果对应的 key 仍是当前 key」才写入,避免旧结果覆盖新集合导致徽章不出现
  const taSymbolsKeyRef = useRef(taSymbolsKey)
  taSymbolsKeyRef.current = taSymbolsKey

  const loadTaMap = useCallback(async () => {
    const runKey = taSymbolsKey
    const symbols = runKey ? runKey.split(',').filter(Boolean) : []
    if (symbols.length === 0) {
      setTaLoadedKey(runKey)
      return
    }
    const next: Record<string, TaInfo | null> = {}
    const queue = [...symbols]
    const worker = async () => {
      while (queue.length > 0) {
        const symbol = queue.shift()
        if (!symbol) continue
        try {
          next[symbol] = buildTaInfo(await tradingAgentsApi.getLatestForStock(symbol))
        } catch {
          // 请求失败不写键 → 该行不渲染,避免把「取不到」误报成「没分析过」
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, () => worker()))
    if (taSymbolsKeyRef.current === runKey) {
      setTaMap(next)
      setTaLoadedKey(runKey)
    }
  }, [taSymbolsKey])

  // 弹窗关闭后只刷新这一只,比全量重拉便宜
  const refreshTaForSymbol = useCallback(async (symbol: string) => {
    try {
      const result = await tradingAgentsApi.getLatestForStock(symbol)
      setTaMap((prev) => ({ ...prev, [symbol]: buildTaInfo(result) }))
    } catch {
      /* 静默:徽章保持旧值,不影响主流程 */
    }
  }, [])

  useEffect(() => {
    void loadTaMap()
  }, [loadTaMap])

  // 回到前台刷新一次:覆盖「点了后台运行、跑完回来」的场景
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadTaMap()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadTaMap])

  const formatPreviewTime = (iso: string): string => {
    try {
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      return d.toLocaleString(getCurrentLocale(), {
        timeZone: browserTimezone(),
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      return iso
    }
  }

  const effectiveSchedule = (agent: AgentConfig, stockAgent?: StockAgentInfo | null): string => {
    const local = (stockAgent?.schedule || '').trim()
    if (local) return local
    return (agent.schedule || '').trim()
  }

  // Refresh quotes only (decoupled from portfolio and scans)
  const handleRefresh = useCallback(async () => {
    if (tourQuoteBusy.current) return
    tourQuoteBusy.current = true
    try {
      await tour?.observeQuote()
      void refreshKlines()
    await Promise.all([
      refreshMarketStatus(),
      refreshQuotes(),
      loadPoolSuggestions(),
      loadPriceAlertSummaries(),
    ])
    } finally { tourQuoteBusy.current = false }
  }, [tour, loadPoolSuggestions, loadPriceAlertSummaries, refreshKlines, refreshMarketStatus, refreshQuotes])

  useEffect(() => {
    const controller = new AbortController()
    void loadInitialData(controller.signal)
    return () => {
      controller.abort()
      initialLoadPromiseRef.current = null
    }
  }, [loadInitialData])

  useEffect(() => {
    if (agentDialogStock) void loadConfigAsync()
  }, [agentDialogStock, loadConfigAsync])

  // Agent 配置弹窗：预览未来触发时间（用于自检工作日/周末语义）
  useEffect(() => {
    if (!agentDialogStock) return
    if (!agents || agents.length === 0) return

    const stockAgentMap = new Map((agentDialogStock.agents || []).map(a => [a.agent_name, a]))
    const schedules = new Map<string, { schedule: string; agent: string }>()
    for (const agent of agents) {
      if (agent.execution_mode === 'batch') continue
      const sa = stockAgentMap.get(agent.name)
      if (!sa) continue
      const eff = effectiveSchedule(agent, sa)
      if (eff) schedules.set(`${agent.name}|${agentDialogStock?.market}|${eff}`, { schedule: eff, agent: agent.name })
    }

    const toFetch = Array.from(schedules.keys()).filter(s => !schedulePreviewCache[s] && !schedulePreviewLoading[s])
    if (toFetch.length === 0) return

    let cancelled = false
    ;(async () => {
      // Mark loading
      setSchedulePreviewLoading(prev => {
        const next = { ...prev }
        for (const s of toFetch) next[s] = true
        return next
      })
      try {
        const pairs = await Promise.all(toFetch.map(async s => {
          try {
            const plan = schedules.get(s)!
            const p = await fetchAPI<SchedulePreview>(`/agents/schedule/preview?schedule=${encodeURIComponent(plan.schedule)}&agent_name=${encodeURIComponent(plan.agent)}&market=${agentDialogStock.market}&count=5`)
            return [s, p] as const
          } catch (e) {
            const msg = e instanceof Error ? e.message : stockT('stocksPage.messages.previewFailed')
            return [s, { error: msg }] as const
          }
        }))
        if (cancelled) return
        setSchedulePreviewCache(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
      } finally {
        if (cancelled) return
        setSchedulePreviewLoading(prev => {
          const next = { ...prev }
          for (const s of toFetch) next[s] = false
          return next
        })
      }
    })()

    return () => { cancelled = true }
  }, [agentDialogStock, agents, schedulePreviewCache, schedulePreviewLoading])

  useQuoteRefresh(autoRefresh, refreshInterval, refreshQuotes)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
      if (positionDropdownRef.current && !positionDropdownRef.current.contains(e.target as Node)) {
        setShowPositionDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ========== Stock handlers ==========
  const doSearch = async (q: string, market: string = searchMarket) => {
    if (q.length < 1) { setSearchResults([]); setShowDropdown(false); return }
    setSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setSearchResults(results)
      setShowDropdown(results.length > 0)
    } catch { setSearchResults([]) }
    finally { setSearching(false) }
  }

  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => doSearch(value), 500)
  }

  const handleSearchMarketChange = (market: string) => {
    setSearchMarket(market)
    if (searchQuery) {
      doSearch(searchQuery, market)
    }
  }

  const refreshStockListCache = async () => {
    setRefreshingStockList(true)
    try {
      const result = await fetchAPI<{ count: number }>('/stocks/refresh-list', { method: 'POST' })
      toast(stockT('stocksPage.messages.refreshListDone', { count: result.count }), 'success')
      if (searchQuery) {
        doSearch(searchQuery)
      }
    } catch (e) {
      toast(stockT('stocksPage.messages.refreshFailed'), 'error')
    } finally {
      setRefreshingStockList(false)
    }
  }

  const selectStock = (item: SearchResult) => {
    setStockForm({ symbol: item.symbol, name: item.name, market: item.market, asset_type: item.asset_type || 'stock' })
    setSearchQuery(`${item.symbol} ${item.name}`)
    setShowDropdown(false)
  }

  const handleStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const created = await stocksApi.create(stockForm)
      const item = { symbol: created.symbol, market: created.market }
      void requestQuotes([item]).then(rows => setQuotes(prev => ({ ...prev, ...toQuoteMap(rows) })))
      void loadNewStockSummary(item)
      setStockForm(emptyStockForm)
      setSearchQuery('')
      setShowStockForm(false)
      load()
      toast(stockT('stocksPage.messages.stockAdded'), 'success')
      await tour?.selectStock(created.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
    }
  }

  const hasAnyPositionForStockId = (id: number): boolean => {
    return (portfolio?.accounts || []).some(acc => (acc.positions || []).some(p => p.stock_id === id))
  }

  const removeFromWatchlist = async (stock: Stock) => {
    if (hasAnyPositionForStockId(stock.id)) {
      toast(stockT('stocksPage.messages.stockHasPosition'), 'error')
      return
    }

    setRemovingWatchStock(true)
    try {
      await stocksApi.remove(stock.id)
      toast(stockT('stocksPage.messages.stockDeleted'), 'success')
      setRemoveWatchStock(null)
      load()
      // 价格提醒/关联配置会随股票删除，刷新一次避免 UI 残留。
      loadPortfolio()
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deleteFailed'), 'error')
    } finally {
      setRemovingWatchStock(false)
    }
  }

  // ========== Account handlers ==========
  const openAccountDialog = (account?: Account) => {
    if (account) {
      setAccountForm({ name: account.name, available_funds: account.available_funds.toString() })
      setEditAccountId(account.id)
    } else {
      setAccountForm(emptyAccountForm)
      setEditAccountId(null)
    }
    setAccountDialogOpen(true)
  }

  const handleAccountSubmit = async () => {
    try {
      const payload = {
        name: accountForm.name,
        available_funds: parseFloat(accountForm.available_funds) || 0,
      }
      if (editAccountId) {
        await fetchAPI(`/accounts/${editAccountId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/accounts', { method: 'POST', body: JSON.stringify(payload) })
      }
      setAccountDialogOpen(false)
      load()
      loadPortfolio()
      toast(editAccountId ? stockT('stocksPage.messages.accountUpdated') : stockT('stocksPage.messages.accountCreated'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.saveAccountFailed'), 'error')
    }
  }

  const handleDeleteAccount = async (id: number) => {
    if (!(await confirmAction(stockT('stocksPage.messages.deleteAccountConfirm'), { destructive: true }))) return
    try {
      await fetchAPI(`/accounts/${id}`, { method: 'DELETE' })
      load()
      loadPortfolio()
      toast(stockT('stocksPage.messages.accountDeleted'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deleteAccountFailed'), 'error')
    }
  }

  // ========== Position handlers ==========
  const openPositionDialog = (accountId: number, position?: Position) => {
    setPositionDialogAccountId(accountId)
    setPositionSearchQuery('')
    setPositionSearchResults([])
    setShowPositionDropdown(false)
    if (position) {
      setPositionForm({
        account_id: accountId,
        stock_id: position.stock_id,
        cost_price: position.cost_price.toString(),
        quantity: position.quantity.toString(),
        invested_amount: position.invested_amount?.toString() || '',
        trading_style: position.trading_style || '',
        stock_symbol: position.symbol,
        stock_name: position.name,
        stock_market: position.market,
        stock_asset_type: position.asset_type || 'stock',
      })
      setEditPositionId(position.id)
    } else {
      setPositionForm({
        account_id: accountId,
        stock_id: 0,
        cost_price: '',
        quantity: '',
        invested_amount: '',
        trading_style: '',
        stock_symbol: '',
        stock_name: '',
        stock_market: 'CN',
        stock_asset_type: 'stock',
      })
      setEditPositionId(null)
    }
    setPositionDialogOpen(true)
  }

  const doPositionSearch = async (q: string, market: string = positionSearchMarket) => {
    if (q.length < 1) { setPositionSearchResults([]); setShowPositionDropdown(false); return }
    setPositionSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setPositionSearchResults(results)
      setShowPositionDropdown(results.length > 0)
    } catch { setPositionSearchResults([]) }
    finally { setPositionSearching(false) }
  }

  const handlePositionSearchInput = (value: string) => {
    setPositionSearchQuery(value)
    clearTimeout(positionSearchTimer.current)
    positionSearchTimer.current = setTimeout(() => doPositionSearch(value), 500)
  }

  const handlePositionSearchMarketChange = (market: string) => {
    setPositionSearchMarket(market)
    if (positionSearchQuery) {
      doPositionSearch(positionSearchQuery, market)
    }
  }

  const selectPositionStock = (item: SearchResult) => {
    // 检查是否已有此股票
    const existing = stocks.find(s => s.symbol === item.symbol && s.market === item.market)
    setPositionForm({
      ...positionForm,
      stock_id: existing?.id || 0,
      stock_symbol: item.symbol,
      stock_name: item.name,
      stock_market: item.market,
      stock_asset_type: existing?.asset_type || item.asset_type || 'stock',
    })
    setPositionSearchQuery(`${item.symbol} ${item.name}`)
    setShowPositionDropdown(false)
  }

  const handlePositionSubmit = async () => {
    try {
      let stockId = positionForm.stock_id
      let createdStock: QuoteRequestItem | undefined

      // 如果是新增且股票不在自选中，先添加到自选
      if (!editPositionId && !stockId && positionForm.stock_symbol) {
        try {
          const newStock = await fetchAPI<Stock>('/stocks', {
            method: 'POST',
            body: JSON.stringify({
              symbol: positionForm.stock_symbol,
              name: positionForm.stock_name,
              market: positionForm.stock_market,
              asset_type: positionForm.stock_asset_type,
            })
          })
          stockId = newStock.id
          createdStock = { symbol: newStock.symbol, market: newStock.market }
          load() // 刷新股票列表
        } catch {
          // 股票可能已存在，尝试获取（兼容并发创建/历史数据）。
          try {
            const existingStocks = await fetchAPI<Stock[]>('/stocks')
            const existing = existingStocks.find(s => s.symbol === positionForm.stock_symbol && s.market === positionForm.stock_market)
            if (existing) {
              stockId = existing.id
            } else {
              toast(stockT('stocksPage.messages.addStockFailed'), 'error')
              return
            }
          } catch (e) {
            toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
            return
          }
        }
      }

      const payload = {
        account_id: positionForm.account_id,
        stock_id: stockId,
        cost_price: parseFloat(positionForm.cost_price),
        quantity: parseInt(positionForm.quantity),
        invested_amount: positionForm.invested_amount ? parseFloat(positionForm.invested_amount) : null,
        trading_style: positionForm.trading_style,  // 空字符串表示清空
      }
      if (editPositionId) {
        await fetchAPI(`/positions/${editPositionId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/positions', { method: 'POST', body: JSON.stringify(payload) })
      }
      const existingStock = stocks.find(stock => stock.id === stockId)
      if (existingStock && (existingStock.asset_type || 'stock') !== positionForm.stock_asset_type) {
        const updatedStock = await fetchAPI<Stock>(`/stocks/${stockId}`, {
          method: 'PUT', body: JSON.stringify({ asset_type: positionForm.stock_asset_type }),
        })
        setStocks(previous => previous.map(stock => stock.id === stockId ? updatedStock : stock))
      }
      setPositionDialogOpen(false)
      if (createdStock) void loadNewStockSummary(createdStock)
      loadPortfolio()
      toast(editPositionId ? stockT('stocksPage.messages.positionUpdated') : stockT('stocksPage.messages.positionAdded'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.savePositionFailed'), 'error')
    }
  }

  const handleDeletePosition = async (id: number) => {
    if (!(await confirmAction(stockT('stocksPage.messages.deletePositionConfirm'), { destructive: true }))) return
    try {
      await fetchAPI(`/positions/${id}`, { method: 'DELETE' })
      loadPortfolio()
      toast(stockT('stocksPage.messages.positionDeleted'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deletePositionFailed'), 'error')
    }
  }

  // ========== Agent handlers ==========
  const toggleAgent = async (stock: Stock, agentName: string) => {
    try {
      const current = stock.agents || []
      const isAssigned = current.some(a => a.agent_name === agentName)
      const newAgents = isAssigned
        ? current.filter(a => a.agent_name !== agentName)
        : [...current, { agent_name: agentName, schedule: '', ai_model_id: null, notify_channel_ids: [] }]
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentBindingFailed'), 'error')
    }
  }

  const triggerStockAgent = async (stockId: number, agentName: string) => {
    setTriggeringAgent(agentName)
    setRunningAgents(prev => ({ ...prev, [stockId]: agentName }))
    // 触发后立即关闭配置弹窗，避免多层弹窗干扰
    setAgentDialogStock(null)
    try {
      // 手动触发时跳过节流，方便测试
      const resp = await fetchAPI<{ result: AgentResult; success?: boolean; message?: string }>(
        `/stocks/${stockId}/agents/${agentName}/trigger?bypass_throttle=true`,
        { method: 'POST' }
      )
      const result = resp?.result
      if (result) {
        // 仅提示，不再弹出结果弹窗，避免干扰
        if (result.success === false) {
          toast(result.message || result.content || stockT('stocksPage.messages.notExecuted'), 'info')
          return
        }
        const isSkipped = !!result.skipped || /已跳过执行|非交易时段/.test(result.content || '')
        if (isSkipped) {
          toast(result.content || stockT('stocksPage.messages.nonTradingSkipped'), 'info')
        } else {
          toast(result.should_alert ? stockT('stocksPage.messages.suggested') : stockT('stocksPage.messages.noNeedAttention'), result.should_alert ? 'success' : 'info')
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : stockT('stocksPage.messages.triggerFailed')
      if (/非交易时段|跳过执行/.test(msg)) {
        toast(msg, 'info')
      } else {
        toast(msg, 'error')
      }
    } finally {
      setTriggeringAgent(null)
      setRunningAgents(prev => ({ ...prev, [stockId]: null }))
    }
  }

  const updateStockAgentModel = async (stock: Stock, agentName: string, modelId: number | null) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, ai_model_id: modelId } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentModelFailed'), 'error')
    }
  }

  const toggleStockAgentChannel = async (stock: Stock, agentName: string, channelId: number) => {
    try {
      const newAgents = (stock.agents || []).map(a => {
        if (a.agent_name !== agentName) return a
        const current = a.notify_channel_ids || []
        const newIds = current.includes(channelId)
          ? current.filter(id => id !== channelId)
          : [...current, channelId]
        return { ...a, notify_channel_ids: newIds }
      })
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentChannelFailed'), 'error')
    }
  }

  const updateStockAgentSchedule = async (stock: Stock, agentName: string, schedule: string) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, schedule } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentScheduleFailed'), 'error')
    }
  }

  // ========== Helpers ==========
  // 隐私打码：只用于上方汇总卡（formatMoney 仍被持仓明细列表使用，不能全局打码）
  const maskVal = (text: string) => (privacyHidden ? '••••' : text)
  const formatMoney = (value: number) => {
    if (Math.abs(value) >= 10000) {
      return `${(value / 10000).toFixed(2)}${stockT('stocksPage.largeUnit')}`
    }
    return value.toFixed(2)
  }

  const marketLabel = (m: string) => m === 'CN' ? stockT('stocksPage.markets.cn') : m === 'HK' ? stockT('stocksPage.markets.hk') : m === 'US' ? stockT('stocksPage.markets.us') : m
  const quoteHint = (quote: { daily_move_status?: string; quote_date?: string | null }) => {
    const status = quote.daily_move_status
    const label = status && status !== 'current' ? stockT(`stocksPage.quoteStatus.${status}`) : ''
    const date = quote.quote_date ? stockT('stocksPage.quoteStatus.asOf', { date: quote.quote_date }) : ''
    return [label, date].filter(Boolean).join(' · ')
  }

  // 市场徽章样式和短标签
  const marketBadge = (m: string) => {
    if (m === 'HK') return { style: 'bg-orange-500/10 text-orange-600', label: stockT('stocksPage.markets.hkShort') }
    if (m === 'US') return { style: 'bg-green-500/10 text-green-600', label: stockT('stocksPage.markets.usShort') }
    return { style: 'bg-blue-500/10 text-blue-600', label: 'A' }
  }

  // 保留原始精度显示价格（不强制截断小数位）
  const formatPrice = (value: number) => {
    // 最多显示4位小数，去除末尾的0
    const formatted = value.toFixed(4).replace(/\.?0+$/, '')
    return formatted
  }

  const formatQuotePrice = (value: number, assetType?: 'stock' | 'etf', market?: string) => value.toFixed(assetType === 'etf' && market !== 'US' ? 3 : 2)

  // 获取股票的行情信息
  const getStockQuote = (quoteKey: string) => {
    return quotes[quoteKey] || null
  }

  const getPriceAlertSummary = (symbol: string, market: string) => {
    const key = `${String(market || 'CN').toUpperCase()}:${String(symbol || '').toUpperCase()}`
    return priceAlertSummaryMap[key] || { total: 0, enabled: 0 }
  }

  // 获取股票的建议信息（优先使用建议池，包含来源和时间信息）
  const getSuggestionForStock = (symbol: string, market: string): { suggestion: SuggestionInfo | null; kline: KlineSummary | null } => {
    const key = `${market || 'CN'}:${symbol}`
    // 优先使用建议池的建议（包含来源和时间信息）
    const poolSug =
      poolSuggestions[key] ||
      (() => {
        const fallback = poolSuggestions[symbol]
        if (!fallback) return null
        const fm = String(fallback.stock_market || '').toUpperCase()
        return fm && fm !== String(market || 'CN').toUpperCase() ? null : fallback
      })()
    if (poolSug) {
      const preloadedKline = klineSummaries[key] || null
      return {
        suggestion: {
          ...poolSug,
          id: poolSug.id,
          action: poolSug.action,
          action_label: poolSug.action_label,
          signal: poolSug.signal,
          reason: poolSug.reason,
          should_alert: poolSug.should_alert ?? (['alert', 'avoid', 'sell', 'reduce'].includes(poolSug.action)),
          agent_name: poolSug.agent_name,
          agent_label: poolSug.agent_label,
          created_at: poolSug.created_at,
          is_expired: poolSug.is_expired,
          prompt_context: poolSug.prompt_context,
          ai_response: poolSug.ai_response,
          meta: poolSug.meta,
        },
        // 优先使用本页并发预取的 kline 摘要，确保徽章与弹窗一致且免加载
        kline: preloadedKline,
      }
    }

    const ks = klineSummaries[key]
    if (ks) return { suggestion: null, kline: ks }

    return { suggestion: null, kline: null }
  }

  const unpricedAccountIds = new Set(
    (portfolio?.accounts || []).filter(account => account.positions.some(position => position.current_price == null)).map(account => account.id),
  )
  const portfolioTotalsReady = unpricedAccountIds.size === 0

  const positionRatio = useMemo(() => {
    if (!portfolio || !portfolioTotalsReady) return null
    const mv = portfolio.total.total_market_value || 0
    const assets = portfolio.total.total_assets || 0
    const pct = assets > 0 ? (mv / assets * 100) : 0
    return { mv, assets, pct }
  }, [portfolio, portfolioTotalsReady])

  const positionsCount = useMemo(() => {
    return (portfolio?.accounts || []).reduce((acc, a) => acc + (a.positions?.length || 0), 0)
  }, [portfolio])

  // 关注页只放「想关注但还没买」的票，持仓股归持仓页。
  // 技术徽章的 hasPosition 目前按页面位置硬编码（自选卡一律 false），持仓股若留在关注页
  // 会显示「买入 / 回避」这类对已持有者无意义的动作，因此在渲染层整体排除。
  const heldKeys = useMemo(() => {
    const set = new Set<string>()
    for (const account of portfolio?.accounts || []) {
      for (const pos of account.positions) {
        set.add(`${String(pos.market || 'CN').toUpperCase()}:${String(pos.symbol || '').toUpperCase()}`)
      }
    }
    return set
  }, [portfolio])

  const watchlistStocks = useMemo(() => {
    return stocks.filter(
      s => !heldKeys.has(`${String(s.market || 'CN').toUpperCase()}:${String(s.symbol || '').toUpperCase()}`),
    )
  }, [stocks, heldKeys])

  const watchlistCount = watchlistStocks.length

  // 持仓页的市场筛选：'' = 全部。只在渲染层过滤，账户级统计（市值/盈亏）仍是全量。
  const filterPositions = useCallback(
    (list: Position[]) =>
      positionMarketFilter
        ? list.filter(p => String(p.market || 'CN').toUpperCase() === positionMarketFilter)
        : list,
    [positionMarketFilter],
  )

  const positionMarketCounts = useMemo(() => {
    const counts: Record<string, number> = { '': 0, CN: 0, HK: 0, US: 0 }
    for (const account of portfolio?.accounts || []) {
      for (const pos of account.positions) {
        counts[''] += 1
        const mk = String(pos.market || 'CN').toUpperCase()
        counts[mk] = (counts[mk] || 0) + 1
      }
    }
    return counts
  }, [portfolio])

  const toggleAccountExpanded = (id: number) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 骨架屏：初始加载时显示
  if (loading) {
    return (
      <div>
        {/* Header Skeleton */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Skeleton className="h-6 w-16 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="hidden md:flex items-center gap-3">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        {/* Summary Cards Skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-4">
              <Skeleton className="h-4 w-16 mb-2" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
        {/* Account List Skeleton */}
        <div className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="card">
              <div className="px-4 py-3 border-b border-border/50">
                <Skeleton className="h-5 w-32" />
              </div>
              <div className="divide-y divide-border/50">
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="px-4 py-3 flex items-center gap-4">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <FirstAnalysis />
      {/* Header */}
      <div className="flex flex-col gap-2 md:gap-3 mb-5 md:mb-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 shrink-0">
            <h1 className="text-[18px] md:text-[22px] font-bold text-foreground tracking-tight">{stockT('stocksPage.messages.portfolio')}</h1>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              aria-label={stockT('stocksPage.messages.privacyToggle')}
              title={stockT('stocksPage.messages.privacyToggle')}
              onClick={() => setPrivacyHidden(!privacyHidden)}
            >
              {privacyHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          </div>
          {/* Desktop buttons + controls */}
          <div className="hidden md:flex items-center gap-3">
            {/* Controls */}
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-accent/30">
              <div className="flex items-center gap-1.5">
                <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="scale-90" />
                <span className="text-[11px] text-muted-foreground">{stockT('stocksPage.autoRefresh')}</span>
                {autoRefresh && (
                  <Select value={refreshInterval.toString()} onValueChange={v => setRefreshInterval(parseInt(v))}>
                    <SelectTrigger className="h-6 w-14 text-[10px] px-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10s</SelectItem>
                      <SelectItem value="30">30s</SelectItem>
                      <SelectItem value="60">{stockT('stocksPage.messages.everyMinutes', { minutes: 1 })}</SelectItem>
                      <SelectItem value="120">{stockT('stocksPage.messages.everyMinutes', { minutes: 2 })}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              {lastRefreshTime && (
                <>
                  <div className="w-px h-4 bg-border" />
                  <span className="text-[10px] text-muted-foreground/60">
                    {lastRefreshTime.toLocaleTimeString(getCurrentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </>
              )}
            </div>
            {/* Buttons */}
            <Button data-tour="refresh-quotes" variant="secondary" onClick={handleRefresh} disabled={quotesLoading || tour?.busy}>
              <RefreshCw className={`w-4 h-4 ${quotesLoading ? 'animate-spin' : ''}`} />
              {stockT('stocksPage.messages.refreshed')}
            </Button>
            <Button variant="secondary" onClick={() => openAccountDialog()}>
              <Building2 className="w-4 h-4" /> {stockT('stocksPage.messages.addAccount')}
            </Button>
            <Button data-tour="add-stock" onClick={() => { setStockForm(emptyStockForm); setSearchQuery(''); setShowStockForm(true) }}>
              <Plus className="w-4 h-4" /> {stockT('stocksPage.messages.addStock')}
            </Button>
          </div>
          {/* Mobile buttons */}
          <div className="flex md:hidden items-center gap-1.5">
            <Button data-tour="refresh-quotes" aria-label={stockT('stocksPage.messages.refreshed')} variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={handleRefresh} disabled={quotesLoading || tour?.busy}>
              <RefreshCw className={`w-4 h-4 ${quotesLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={() => openAccountDialog()}>
              <Building2 className="w-4 h-4" />
            </Button>
            <Button data-tour="add-stock" aria-label={stockT('stocksPage.messages.addStock')} size="sm" className="h-8 w-8 p-0" onClick={() => { setStockForm(emptyStockForm); setSearchQuery(''); setShowStockForm(true) }}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* 移动端 row 2：市场状态 + 自动刷新 + 时间戳合并到同一行,横向滚动避免换行；桌面端只展示市场 pills (auto-refresh 在桌面顶部已展示) */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none -mx-1 px-1 md:flex-wrap md:overflow-visible">
          {marketStatus.length > 0 && <MarketCalendarStatus markets={marketStatus} labelMarket={marketLabel} />}
          {/* 移动端紧凑型自动刷新控件 */}
          <div className="flex md:hidden shrink-0 items-center gap-1 px-2 py-0.5 rounded-full bg-accent/30 ml-1">
            <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="scale-75" />
            {autoRefresh ? (
              <Select value={refreshInterval.toString()} onValueChange={v => setRefreshInterval(parseInt(v))}>
                <SelectTrigger className="h-5 w-12 text-[10px] px-1 border-0 bg-transparent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10s</SelectItem>
                  <SelectItem value="30">30s</SelectItem>
                  <SelectItem value="60">{stockT('stocksPage.messages.everyMinutes', { minutes: 1 })}</SelectItem>
                  <SelectItem value="120">{stockT('stocksPage.messages.everyMinutes', { minutes: 2 })}</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <span className="text-[10px] text-muted-foreground">{stockT('stocksPage.autoRefresh')}</span>
            )}
          </div>
          {lastRefreshTime && (
            <span className="md:hidden shrink-0 text-[10px] text-muted-foreground/60 font-mono ml-1">
              {lastRefreshTime.toLocaleTimeString(getCurrentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {/* Portfolio Total Summary */}
      {portfolioLoading && !portfolio ? (
        // 首次加载时显示骨架屏
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : portfolio ? (
        <div data-testid="portfolio-summary" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.totalMarketValue')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {portfolioTotalsReady ? maskVal(formatMoney(portfolio.total.total_market_value)) : '--'}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              {portfolio.total.total_pnl >= 0 ? (
                <ArrowUpRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`} />
              ) : (
                <ArrowDownRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`} />
              )}
              <span className="text-[12px]">{stockT('stocksPage.messages.totalPnl')}</span>
            </div>
            <div className={`text-[20px] font-bold font-mono ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`}>
              {portfolioTotalsReady ? maskVal(`${portfolio.total.total_pnl >= 0 ? '+' : ''}${formatMoney(portfolio.total.total_pnl)}`) : '--'}
              {portfolioTotalsReady && <span className="block text-[13px] md:inline md:ml-1.5">
                ({maskVal(`${portfolio.total.total_pnl_pct >= 0 ? '+' : ''}${portfolio.total.total_pnl_pct.toFixed(2)}%`)})
              </span>}
              {portfolioTotalsReady && portfolio.total.total_net_pnl != null && (
                <span className="block text-[13px] md:inline md:ml-1.5">
                  净 {maskVal(`${portfolio.total.total_net_pnl >= 0 ? '+' : ''}${formatMoney(portfolio.total.total_net_pnl)}`)} ({portfolio.total.total_net_pnl_pct != null ? maskVal(`${portfolio.total.total_net_pnl_pct >= 0 ? '+' : ''}${portfolio.total.total_net_pnl_pct.toFixed(2)}%`) : ''})
                </span>
              )}
            </div>
          </div>

          {(() => {
            const dayPnl = portfolio.total.total_daily_pnl
            const totalMv = portfolio.total.total_market_value
            const prevMv = totalMv - dayPnl
            const pct = prevMv > 0 ? (dayPnl / prevMv * 100) : 0
            const isUp = dayPnl >= 0
            return (
              <div className="card p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {isUp ? (
                    <ArrowUpRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`} />
                  ) : (
                    <ArrowDownRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`} />
                  )}
                  <span className="text-[12px]">{stockT('stocksPage.messages.todayPnl')}</span>
                </div>
                <div className={`text-[20px] font-bold font-mono ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`}>
                  {portfolioTotalsReady ? maskVal(`${isUp ? '+' : ''}${formatMoney(dayPnl)}`) : '--'}
                  {portfolioTotalsReady && <span className="block text-[13px] md:inline md:ml-1.5">({maskVal(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`)})</span>}
                </div>
              </div>
            )
          })()}

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Wallet className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.availableFundsShort')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {maskVal(formatMoney(portfolio.total.available_funds))}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <PiggyBank className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.totalAssets')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {portfolioTotalsReady ? maskVal(formatMoney(portfolio.total.total_assets)) : '--'}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Bell className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.positionRatio')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {positionRatio ? maskVal(`${positionRatio.pct.toFixed(1)}%`) : '--'}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
              {positionRatio ? maskVal(stockT('stocksPage.messages.positionValueSummary', { value: formatMoney(positionRatio.mv), assets: formatMoney(positionRatio.assets) })) : stockT('stocksPage.messages.empty')}
            </div>
          </div>
        </div>
      ) : null}

      {/* Tabs: Positions / Watchlist */}
      <div className="mb-4">
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-accent/30">
          <button
            onClick={() => setViewTab('positions')}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${
              viewTab === 'positions'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {stockT('stocksPage.messages.portfolio')} <span className="ml-1 font-mono text-[11px] opacity-70">{positionsCount}</span>
          </button>
          <button
            onClick={() => setViewTab('watchlist')}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${
              viewTab === 'watchlist'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {stockT('stocksPage.messages.watch')} <span className="ml-1 font-mono text-[11px] opacity-70">{watchlistCount}</span>
          </button>
        </div>
      </div>

      {/* Add Stock Dialog */}
      <Dialog open={showStockForm} onOpenChange={(open) => { setShowStockForm(open); if (!open) { setSearchQuery(''); setSearchMarket('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{stockT('stocksPage.messages.addToWatchlistTitle')}</DialogTitle>
            <DialogDescription>{stockT('stocksPage.messages.addToWatchlistDescription')}</DialogDescription>
          </DialogHeader>
          <div data-tour-instructions />
          <form data-tour="stock-form" onSubmit={handleStockSubmit}>
            <div className="relative" ref={dropdownRef}>
              <div className="flex items-center gap-2 mb-2">
                <Label className="mb-0">{stockT('stocksPage.messages.searchStock')}</Label>
                <div className="flex items-center gap-1">
                  {[
                    { value: '', label: stockT('stocksPage.markets.all') },
                    { value: 'CN', label: stockT('stocksPage.markets.cn') },
                    { value: 'HK', label: stockT('stocksPage.markets.hk') },
                    { value: 'US', label: stockT('stocksPage.markets.us') },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleSearchMarketChange(opt.value)}
                      className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                        searchMarket === opt.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={refreshStockListCache}
                  disabled={refreshingStockList}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-2"
                  title={stockT('stocksPage.messages.searchRefreshHint')}
                >
                  {refreshingStockList ? (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" /> {stockT('stocksPage.messages.refreshing')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3" /> {stockT('stocksPage.messages.refreshList')}
                    </span>
                  )}
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <Input
                  value={searchQuery}
                  onChange={e => handleSearchInput(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                  placeholder={stockT('stocksPage.messages.searchPlaceholder', { example: searchMarket === 'HK' ? '00700 / 02800' : searchMarket === 'US' ? 'AAPL / SPY' : '600519 / 510300' })}
                  className="pl-10"
                  autoComplete="off"
                />
                {searching && <span className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
              </div>
              {showDropdown && (
                <div className="relative w-full mt-2 max-h-64 overflow-auto overscroll-contain scrollbar card shadow-lg">
                  {searchResults.map(item => (
                    <button
                      key={`${item.market}-${item.symbol}`}
                      type="button"
                      onClick={() => selectStock(item)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-accent/50 text-left transition-colors"
                    >
                      <span className="font-mono text-muted-foreground text-[12px] w-14">{item.symbol}</span>
                      <span className="flex-1 font-medium text-foreground">{item.name}</span>
                      {item.asset_type === 'etf' && <Badge variant="secondary">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                      <Badge variant="secondary">{marketLabel(item.market)}</Badge>
                    </button>
                  ))}
                </div>
              )}
              {stockForm.symbol && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Badge><span className="font-mono">{stockForm.symbol}</span> {stockForm.name}</Badge>
                  <Badge variant="secondary">{marketLabel(stockForm.market)}</Badge>
                  <Select value={stockForm.asset_type} onValueChange={value => setStockForm({ ...stockForm, asset_type: value as 'stock' | 'etf' })}>
                    <SelectTrigger aria-label={stockT('stocksPage.assetTypes.label')} className="w-28 h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stock">{stockT('stocksPage.assetTypes.stock')}</SelectItem>
                      <SelectItem value="etf">{stockT('stocksPage.assetTypes.etf')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center gap-3 justify-end">
              <Button type="button" variant="ghost" onClick={() => { setShowStockForm(false); setSearchQuery('') }}>{stockT('stocksPage.messages.cancel')}</Button>
              <Button type="submit" disabled={!stockForm.symbol}>{stockT('stocksPage.messages.confirmAdd')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Accounts & Positions */}
      {viewTab === 'positions' && (
        portfolio && portfolio.accounts.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-20">
            <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
              <Building2 className="w-6 h-6 text-primary" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">{stockT('stocksPage.messages.noAccount')}</p>
            <p className="text-[13px] text-muted-foreground mt-1.5">{stockT('stocksPage.messages.createFirstAccount')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-1">
              <div className="text-[11px] text-muted-foreground/70 truncate">
                {positionMarketFilter ? stockT('stocksPage.messages.positionStatsHint') : ''}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {[
                { value: '', label: stockT('stocksPage.markets.all'), count: positionMarketCounts[''] },
                { value: 'CN', label: stockT('stocksPage.markets.cn'), count: positionMarketCounts.CN },
                { value: 'HK', label: stockT('stocksPage.markets.hk'), count: positionMarketCounts.HK },
                { value: 'US', label: stockT('stocksPage.markets.us'), count: positionMarketCounts.US },
              ]
                .filter(opt => opt.value === '' || opt.count > 0)
                .map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setPositionMarketFilter(opt.value)}
                    className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                      positionMarketFilter === opt.value
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {opt.label} ({opt.count})
                  </button>
                ))}
              </div>
            </div>
            {portfolio?.accounts
              .filter(account => !positionMarketFilter || filterPositions(account.positions).length > 0)
              .map(account => (
              <div key={account.id} className="card overflow-hidden">
              {/* Account Header */}
              <div
                className="flex flex-col md:flex-row md:items-center justify-between p-3 md:p-4 cursor-pointer hover:bg-accent/30 transition-colors gap-2"
                onClick={() => toggleAccountExpanded(account.id)}
              >
                <div className="flex items-center gap-2 md:gap-3">
                  {expandedAccounts.has(account.id) ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                  <Building2 className="w-4 h-4 text-primary" />
                  <span className="text-[14px] md:text-[15px] font-semibold text-foreground">{account.name}</span>
                  <span className="text-[11px] md:text-[12px] text-muted-foreground">
                    {positionMarketFilter
                      ? stockT('stocksPage.messages.positionCountFiltered', {
                          shown: filterPositions(account.positions).length,
                          total: account.positions.length,
                        })
                      : stockT('stocksPage.messages.positionCount', { count: account.positions.length })}
                  </span>
                </div>
                <div className="flex items-center justify-between md:justify-end gap-2 md:gap-6 pl-6 md:pl-0">
                  <div
                    className="flex items-center gap-2.5 md:gap-6 min-w-0"
                    data-testid={`account-amounts-${account.id}`}
                    title={positionMarketFilter ? stockT('stocksPage.messages.positionStatsHint') : undefined}
                  >
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.marketValue')}</div>
                      <div className="text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap">{unpricedAccountIds.has(account.id) ? '--' : maskVal(formatMoney(account.total_market_value))}</div>
                    </div>
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.pnl')}</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap ${marketSignTextClass(unpricedAccountIds.has(account.id) ? null : account.total_pnl)}`}>
                        {unpricedAccountIds.has(account.id) ? '--' : maskVal(`${account.total_pnl >= 0 ? '+' : ''}${formatMoney(account.total_pnl)}`)}
                        {!unpricedAccountIds.has(account.id) && <span className="text-[10px] md:text-[11px] ml-1 hidden md:inline">({maskVal(`${account.total_pnl_pct >= 0 ? '+' : ''}${account.total_pnl_pct.toFixed(2)}%`)})</span>}
                      </div>
                      {!unpricedAccountIds.has(account.id) && account.total_net_pnl != null && (
                        <div className="text-[10px] md:text-[11px] font-mono text-muted-foreground whitespace-nowrap">
                          净 {maskVal(`${account.total_net_pnl >= 0 ? '+' : ''}${formatMoney(account.total_net_pnl)}`)} ({account.total_net_pnl_pct != null ? maskVal(`${account.total_net_pnl_pct >= 0 ? '+' : ''}${account.total_net_pnl_pct.toFixed(2)}%`) : ''})
                        </div>
                      )}
                    </div>
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.today')}</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap ${marketSignTextClass(unpricedAccountIds.has(account.id) ? null : account.total_daily_pnl)}`}>
                        {unpricedAccountIds.has(account.id) ? '--' : maskVal(`${account.total_daily_pnl >= 0 ? '+' : ''}${formatMoney(account.total_daily_pnl)}`)}
                      </div>
                    </div>
                    <div className="text-left md:text-right hidden sm:block">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.availableFundsShort')}</div>
                      <div className="text-[12px] md:text-[13px] font-mono whitespace-nowrap">{maskVal(formatMoney(account.available_funds))}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0 md:gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" onClick={() => openPositionDialog(account.id)} aria-label={stockT('stocksPage.messages.addPosition')}>
                      <Plus className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" aria-label={stockT('stocksPage.messages.editAccount')} onClick={() => openAccountDialog(accounts.find(a => a.id === account.id))}>
                      <Pencil className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8 hover:text-destructive" onClick={() => handleDeleteAccount(account.id)}>
                      <Trash2 className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Positions */}
              {expandedAccounts.has(account.id) && (
                <div className="border-t border-border/30">
                  {filterPositions(account.positions).length === 0 ? (
                    <p className="text-[13px] text-muted-foreground text-center py-8">{stockT('stocksPage.messages.noPositions')}</p>
                  ) : (
                    <>
                      {/* Desktop Table */}
                      <div className="hidden md:block overflow-x-auto scrollbar">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-border/30 bg-accent/20">
                              <th className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.stock')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.currentPrice')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.change')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.cost')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.holding')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.marketValue')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.pnl')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground" title={stockT('stocksPage.messages.netPnlHint')}>{stockT('stocksPage.messages.netPnl')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.today')}</th>
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.style')}</th>
                              <th className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.agent')}</th>
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.actions')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filterPositions(account.positions).map((pos, i) => {
                              const stock = stocks.find(s => s.id === pos.stock_id)
                              const badge = marketBadge(pos.market)
                              const isForeign = pos.market === 'HK' || pos.market === 'US'
                              const changeColor = marketSignTextClass(pos.change_pct)
                              const pnlColor = marketSignTextClass(pos.pnl)
                              return (
                                <tr
                                  key={pos.id}
                                  draggable
                                  onDragStart={(e) => {
                                    positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                    setDraggingPositionId(pos.id)
                                    setDraggingPositionAccountId(account.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                  }}
                                  onDragOver={(e) => {
                                    e.preventDefault()
                                    e.dataTransfer.dropEffect = 'move'
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      previewPositionReorder(account.id, draggingPositionId, pos.id)
                                    }
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault()
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      commitPositionReorder(account.id)
                                    }
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  onDragEnd={() => {
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  className={`group hover:bg-accent/30 transition-colors ${i > 0 ? 'border-t border-border/20' : ''} ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                                >
                                  {/* 宽屏不换行：UZI / AI / 指标三个徽章都留在名字这一行，框下时间才在同一底线；
                                      窄屏（<1480px）保留折行，12 列本来就不够放 */}
                                  <td className="px-4 py-2.5 min-[1480px]:whitespace-nowrap">
                                    {/* 名字与徽章「框对框」居中：NameRow 的 26px 格与徽章框等高，栈底对齐后自然居中 */}
                                    <NameRow>
                                      <span className={`text-[9px] px-1 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                                      <span className="font-mono text-[12px] font-semibold text-foreground">
                                        {pos.symbol}
                                      </span>
                                      <button
                                        className="text-[12px] text-muted-foreground hover:text-primary"
                                        onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                      >
                                        {pos.name}
                                        {pos.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                                      </button>
                                      <ThsLink symbol={pos.symbol} market={pos.market} name={pos.name} />
                                      <StockNoteButton
                                        stockId={pos.stock_id}
                                        note={stock?.note}
                                        onSaved={handleStockNoteSaved}
                                      />
                                    </NameRow>
                                    {(() => {
                                      const uzi = uziMap[`${pos.symbol}|${pos.market}`]
                                      return uzi ? (
                                        <UziTag info={uzi} onOpen={() => openUziReport(pos.symbol, pos.market, pos.name, true)} />
                                      ) : (
                                        <UziEmptyTag onOpen={() => openUziReport(pos.symbol, pos.market, pos.name, true)} />
                                      )
                                    })()}
                                    {taLoadedKey === taSymbolsKey && (() => {
                                      const ta = taMap[pos.symbol]
                                      return ta ? (
                                        <TaTag info={ta} onOpen={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)} />
                                      ) : (
                                        <TaEmptyTag onOpen={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)} />
                                      )
                                    })()}
                                    {(() => {
                                      const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market)
                                      return (suggestion || kline) ? (
                                        // align-bottom：整块贴着行底，框下时间与 UZI 的框下时间同一底线
                                        <span className="align-bottom inline-flex ml-2 mr-2">
                                          <SuggestionBadge
                                            suggestion={suggestion}
                                            stockName={pos.name}
                                            stockSymbol={pos.symbol}
                                            kline={kline}
                                            market={pos.market}
                                            hasPosition={true}
                                            onReEvaluated={() => loadPoolSuggestions()}
                                          />
                                        </span>
                                      ) : null
                                    })()}
                                  </td>
                                  <td title={quoteHint(pos)} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                    {pos.current_price != null ? <span>{formatQuotePrice(pos.current_price, pos.asset_type, pos.market)}{isForeign ? (pos.market === 'HK' ? ' HKD' : ' USD') : ''}</span> : '—'}
                                  </td>
                                  <td title={quoteHint(pos)} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                    {pos.change_pct != null ? `${pos.change_pct >= 0 ? '+' : ''}${pos.change_pct.toFixed(2)}%` : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{formatPrice(pos.cost_price)}</td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{pos.quantity}</td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">
                                    {pos.market_value != null ? (
                                      <div className="flex flex-col items-end">
                                        {isForeign ? (
                                          <>
                                            <span>{formatMoney(pos.market_value)} {pos.market === 'HK' ? 'HKD' : 'USD'}</span>
                                            {pos.market_value_cny && <span className="text-[10px] text-muted-foreground/60">≈{formatMoney(pos.market_value_cny)}</span>}
                                          </>
                                        ) : <span>{formatMoney(pos.market_value)}</span>}
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${pnlColor}`}>
                                    {pos.pnl != null ? (
                                      <div className="flex flex-col items-end">
                                        <span>{pos.pnl >= 0 ? '+' : ''}{formatMoney(pos.pnl)}</span>
                                        <span className="text-[10px] opacity-70">{pos.pnl_pct != null ? `${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(2)}%` : ''}{isForeign && ' CNY'}</span>
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px]" title={pos.net_pnl != null ? `净盈亏（含费口径）：市值 - 含买入费成本 - 预估卖出费` + (pos.net_cost_price != null ? ` · 含费成本价 ${formatPrice(pos.net_cost_price)}${isForeign ? (pos.market === 'HK' ? ' HKD' : ' USD') : ''}` : '') + (pos.est_fees_cny != null ? ` · 预估费用 ¥${formatMoney(pos.est_fees_cny)}` : '') : undefined}>
                                    {pos.net_pnl != null ? (
                                      <div className="flex flex-col items-end">
                                        <span className={marketSignTextClass(pos.net_pnl)}>{pos.net_pnl >= 0 ? '+' : ''}{formatMoney(pos.net_pnl)}</span>
                                        <span className="text-[10px] opacity-70 text-muted-foreground">{pos.net_pnl_pct != null ? `${pos.net_pnl_pct >= 0 ? '+' : ''}${pos.net_pnl_pct.toFixed(2)}%` : ''}{isForeign && ' CNY'}</span>
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${marketSignTextClass(pos.daily_pnl)}`}>
                                    {pos.daily_pnl != null ? (
                                      <div className="flex flex-col items-end">
                                        <span>{pos.daily_pnl >= 0 ? '+' : ''}{formatMoney(pos.daily_pnl)}</span>
                                        <span className="text-[10px] opacity-70">{pos.daily_pnl_pct != null ? `${pos.daily_pnl_pct >= 0 ? '+' : ''}${pos.daily_pnl_pct.toFixed(2)}%` : ''}</span>
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    {pos.trading_style ? (
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                        {pos.trading_style === 'short' ? stockT('stocksPage.messages.shortStyle') : pos.trading_style === 'long' ? stockT('stocksPage.messages.longStyle') : stockT('stocksPage.messages.swingStyle')}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground/50">-</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {stock && (
                                      <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity">
                                        {stock.agents && stock.agents.length > 0 ? (
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            {stock.agents.map(sa => {
                                              const agent = agents.find(a => a.name === sa.agent_name)
                                              const isRunning = runningAgents[stock.id] === sa.agent_name
                                              return (
                                                <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                                  <Badge variant="default" className="text-[10px]">{agentName(sa.agent_name, sa.display_name || agent?.display_name)}</Badge>
                                                  {isRunning && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                      <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                      {stockT('stocksPage.messages.executing')}
                                                    </span>
                                                  )}
                                                </span>
                                              )
                                            })}
                                          </div>
                                        ) : (
                                          <span className="text-[11px] text-muted-foreground/50 flex items-center gap-1"><Bot className="w-3 h-3" /> {stockT('stocksPage.messages.notConfigured')}</span>
                                        )}
                                      </button>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market); return (!suggestion && !kline) ? (
                                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title={stockT('stocksPage.messages.klineIndicator')}><BarChart3 className="w-3 h-3" /></Button>
                                      ) : null })()}
                                      <StockPriceAlertPanel
                                        mode="icon"
                                        stockId={pos.stock_id}
                                        symbol={pos.symbol}
                                        market={pos.market}
                                        stockName={pos.name}
                                        initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                        initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                        onChanged={loadPriceAlertSummaries}
                                      />
                                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openNewsDialog(pos.name)} title={stockT('stocksPage.messages.relatedNews')}><Newspaper className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary" title={stockT('stocksPage.messages.deepAnalysis')} onClick={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)}><Brain className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={stockT('stocksPage.messages.editPosition')} onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile Cards */}
                      <div className="md:hidden divide-y divide-border/30">
                        {filterPositions(account.positions).map(pos => {
                          const stock = stocks.find(s => s.id === pos.stock_id)
                          const badge = marketBadge(pos.market)
                          const changeColor = marketSignTextClass(pos.change_pct)
                          const pnlColor = marketSignTextClass(pos.pnl)
                          return (
                            <div
                              key={pos.id}
                              draggable
                              onDragStart={(e) => {
                                positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                setDraggingPositionId(pos.id)
                                setDraggingPositionAccountId(account.id)
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  previewPositionReorder(account.id, draggingPositionId, pos.id)
                                }
                              }}
                              onDrop={(e) => {
                                e.preventDefault()
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  commitPositionReorder(account.id)
                                }
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              onDragEnd={() => {
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              className={`p-3 hover:bg-accent/30 transition-colors ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                            >
                              {/* Row 1: Stock info + Current price */}
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <NameRow className="min-w-0">
                                    <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                                    <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
                                      {pos.symbol}
                                    </span>
                                    <button
                                      className="min-w-0 text-[12px] text-muted-foreground hover:text-primary truncate"
                                      onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                    >
                                      {pos.name}
                                      {pos.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                                    </button>
                                    <ThsLink symbol={pos.symbol} market={pos.market} name={pos.name} />
                                    <StockNoteButton
                                      stockId={pos.stock_id}
                                      note={stock?.note}
                                      onSaved={handleStockNoteSaved}
                                    />
                                  </NameRow>
                                  {(() => {
                                    const uzi = uziMap[`${pos.symbol}|${pos.market}`]
                                    return uzi ? (
                                      <UziTag info={uzi} onOpen={() => openUziReport(pos.symbol, pos.market, pos.name, true)} />
                                    ) : (
                                      <UziEmptyTag onOpen={() => openUziReport(pos.symbol, pos.market, pos.name, true)} />
                                    )
                                  })()}
                                  {taLoadedKey === taSymbolsKey && (() => {
                                    const ta = taMap[pos.symbol]
                                    return ta ? (
                                      <TaTag info={ta} onOpen={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)} />
                                    ) : (
                                      <TaEmptyTag onOpen={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)} />
                                    )
                                  })()}
                                  {pos.trading_style && (
                                    // self-start + 26px 格：与 NameRow / UZI 徽章框同一水平（框对框居中，不跟整栈一起被 items-center 拉低 6px）
                                    <span className="self-start inline-flex h-[26px] shrink-0 items-center">
                                      <span className={`text-[9px] px-1 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                        {pos.trading_style === 'short' ? stockT('stocksPage.messages.shortStyleLabel') : pos.trading_style === 'long' ? stockT('stocksPage.messages.longStyleLabel') : stockT('stocksPage.messages.swingStyleLabel')}
                                      </span>
                                    </span>
                                  )}
                                </div>
                                <div title={quoteHint(pos)} className={`font-mono text-[13px] font-medium whitespace-nowrap shrink-0 ${changeColor}`}>
                                  {pos.current_price != null ? formatQuotePrice(pos.current_price, pos.asset_type, pos.market) : '—'}
                                  <span className="text-[11px] ml-1">{pos.change_pct != null ? `${pos.change_pct >= 0 ? '+' : ''}${pos.change_pct.toFixed(2)}%` : '—'}</span>
                                </div>
                              </div>
                              {/* Row 2 (Suggestion badge, dedicated row to avoid wrapping mess) */}
                              {(() => {
                                const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market)
                                return (suggestion || kline) ? (
                                  <div className="mb-2">
                                    <SuggestionBadge
                                      suggestion={suggestion}
                                      stockName={pos.name}
                                      stockSymbol={pos.symbol}
                                      kline={kline}
                                      market={pos.market}
                                      hasPosition={true}
                                      onReEvaluated={() => loadPoolSuggestions()}
                                    />
                                  </div>
                                ) : null
                              })()}
                              {/* Row 3: Stats grid (4 cols, whitespace-nowrap to prevent "万" wrapping) */}
                              <div className="grid grid-cols-4 gap-2 text-[11px]">
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.cost')}</div>
                                  <div className="font-mono text-foreground truncate" title={String(pos.cost_price)}>{formatPrice(pos.cost_price)}</div>
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.quantity')}</div>
                                  <div className="font-mono text-foreground truncate" title={String(pos.quantity)}>{pos.quantity}</div>
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.pnl')}</div>
                                  <div className={`font-mono whitespace-nowrap ${pnlColor}`}>
                                    {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}${formatMoney(pos.pnl)}` : '—'}
                                  </div>
                                  {pos.pnl_pct != null && (
                                    <div className={`text-[10px] font-mono ${pnlColor} opacity-80`}>
                                      {pos.pnl_pct >= 0 ? '+' : ''}{pos.pnl_pct.toFixed(2)}%
                                    </div>
                                  )}
                                  {pos.net_pnl != null && (
                                    <div className={`text-[10px] font-mono ${marketSignTextClass(pos.net_pnl)} opacity-80`}>
                                      净 {pos.net_pnl >= 0 ? '+' : ''}{formatMoney(pos.net_pnl)}
                                    </div>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.today')}</div>
                                  <div className={`font-mono whitespace-nowrap ${marketSignTextClass(pos.daily_pnl)}`}>
                                    {pos.daily_pnl != null ? `${pos.daily_pnl >= 0 ? '+' : ''}${formatMoney(pos.daily_pnl)}` : '—'}
                                  </div>
                                </div>
                              </div>
                              {/* Row 4: Actions */}
                              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/20">
                                <div>
                                  {stock && stock.agents && stock.agents.length > 0 ? (
                                    <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1">
                                      {stock.agents.slice(0, 2).map(sa => {
                                        const agent = agents.find(a => a.name === sa.agent_name)
                                        const isRunning = runningAgents[stock.id] === sa.agent_name
                                        return (
                                          <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                          <Badge variant="secondary" className="text-[9px]">{agentName(sa.agent_name, sa.display_name || agent?.display_name)}</Badge>
                                            {isRunning && (
                                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                {stockT('stocksPage.messages.executing')}
                                              </span>
                                            )}
                                          </span>
                                        )
                                      })}
                                    </button>
                                  ) : (
                                    <button onClick={() => stock && setAgentDialogStock(stock)} className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                                      <Bot className="w-3 h-3" /> {stockT('stocksPage.messages.agent')}
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market); return (!suggestion && !kline) ? (
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title={stockT('stocksPage.messages.klineIndicator')}><BarChart3 className="w-3 h-3" /></Button>
                                  ) : null })()}
                                  <StockPriceAlertPanel
                                    mode="icon"
                                    stockId={pos.stock_id}
                                    symbol={pos.symbol}
                                    market={pos.market}
                                    stockName={pos.name}
                                    initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                    initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                    onChanged={loadPriceAlertSummaries}
                                  />
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openNewsDialog(pos.name)}><Newspaper className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary" title={stockT('stocksPage.messages.deepAnalysis')} onClick={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)}><Brain className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={stockT('stocksPage.messages.editPosition')} onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        )
      )}

      {/* Watchlist */}
      {viewTab === 'watchlist' && (
        <div data-tour="watchlist" className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-foreground">{stockT('stocksPage.messages.watchlist')}</h3>
            <div className="flex items-center gap-1">
              {[
                { value: '', label: stockT('stocksPage.markets.all'), count: watchlistStocks.length },
                { value: 'CN', label: stockT('stocksPage.markets.cn'), count: watchlistStocks.filter(s => s.market === 'CN').length },
                { value: 'HK', label: stockT('stocksPage.markets.hk'), count: watchlistStocks.filter(s => s.market === 'HK').length },
                { value: 'US', label: stockT('stocksPage.markets.us'), count: watchlistStocks.filter(s => s.market === 'US').length },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setStockListFilter(opt.value)}
                  className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                    stockListFilter === opt.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {opt.label} ({opt.count})
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] text-muted-foreground">{stockT('stocksPage.messages.filter')}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setWatchlistOnlyAlerts(!watchlistOnlyAlerts)}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  watchlistOnlyAlerts
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-600'
                    : 'bg-accent/30 border-border/50 text-muted-foreground hover:border-rose-500/30'
                }`}
              title={stockT('stocksPage.messages.onlyAlerts')}
              >
                {stockT('stocksPage.messages.onlyAlerts')}
              </button>
            </div>
          </div>
          {watchlistStocks.length === 0 ? (
            <div className="py-12 text-center">
              {stocks.length === 0 ? (
                <>
                  <div className="text-[13px] text-muted-foreground">{stockT('stocksPage.messages.noWatchlist')}</div>
                  <div className="mt-2 text-[11px] text-muted-foreground/70">{stockT('stocksPage.messages.startAddWatchlist')}</div>
                </>
              ) : (
                <>
                  <div className="text-[13px] text-muted-foreground">{stockT('stocksPage.messages.noWatchlistAllHeld')}</div>
                  <div className="mt-2 text-[11px] text-muted-foreground/70">{stockT('stocksPage.messages.startAddWatchlistAllHeld')}</div>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {watchlistStocks
                .filter(s => !stockListFilter || s.market === stockListFilter)
                .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
                .filter(stock => {
                  if (tour?.active || !watchlistOnlyAlerts) return true
                  const { suggestion } = getSuggestionForStock(stock.symbol, stock.market)
                  return !!suggestion?.should_alert
                })
                .map((stock) => {
                const quote = getStockQuote(`${stock.market}:${stock.symbol}`)
                const changeColor = marketSignTextClass(quote?.change_pct)
                const { suggestion, kline } = getSuggestionForStock(stock.symbol, stock.market)
                return (
                  <div
                    key={stock.id}
                    data-tour-stock={stock.id}
                    role={tour?.active && tour.step === 'stock' ? 'button' : undefined}
                    tabIndex={tour?.active && tour.step === 'stock' ? 0 : undefined}
                    onKeyDown={e => { if (tour?.active && tour.step === 'stock' && ['Enter', ' '].includes(e.key)) { e.preventDefault(); void tour.selectStock(stock.id) } }}
                    draggable={stockListFilter === '' && !watchlistOnlyAlerts}
                    onDragStart={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      watchDragSnapshotRef.current = stocks
                      setDraggingWatchStockId(stock.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (draggingWatchStockId != null) {
                        previewWatchlistReorder(draggingWatchStockId, stock.id)
                      }
                    }}
                    onDrop={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      e.preventDefault()
                      if (draggingWatchStockId != null) commitWatchlistReorder()
                      setDraggingWatchStockId(null)
                      watchDragSnapshotRef.current = null
                    }}
                    onDragEnd={() => {
                      setDraggingWatchStockId(null)
                      watchDragSnapshotRef.current = null
                    }}
                    className={`group rounded-xl border border-border/40 bg-background/30 hover:bg-accent/20 transition-colors p-3 cursor-pointer ${draggingWatchStockId === stock.id ? 'opacity-60' : ''}`}
                    onClick={() => {
                      if (isSuppressCardClick()) return
                      if (tour?.active && tour.step === 'stock') { void tour.selectStock(stock.id); return }
                      setAgentDialogStock(stock)
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <NameRow className="min-w-0">
                            <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded ${marketBadge(stock.market).style}`}>
                              {marketBadge(stock.market).label}
                            </span>
                            <button
                              className="shrink-0 font-mono text-[12px] font-semibold text-foreground hover:text-primary"
                              onClick={(e) => { e.stopPropagation(); if (tour?.active && tour.step === 'stock') { void tour.selectStock(stock.id); return }; openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                            >
                              {stock.symbol}
                            </button>
                            <button
                              className="min-w-0 text-[12px] text-muted-foreground truncate hover:text-primary"
                              onClick={(e) => { e.stopPropagation(); if (tour?.active && tour.step === 'stock') { void tour.selectStock(stock.id); return }; openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                            >
                              {stock.name}
                              {stock.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                            </button>
                            <ThsLink symbol={stock.symbol} market={stock.market} name={stock.name} />
                            <StockNoteButton
                              stockId={stock.id}
                              note={stock.note}
                              onSaved={handleStockNoteSaved}
                            />
                          </NameRow>
                          {(() => {
                            const uzi = uziMap[`${stock.symbol}|${stock.market}`]
                            return uzi ? (
                              <UziTag info={uzi} onOpen={() => openUziReport(stock.symbol, stock.market, stock.name, false)} />
                            ) : (
                              <UziEmptyTag onOpen={() => openUziReport(stock.symbol, stock.market, stock.name, false)} />
                            )
                          })()}
                          {taLoadedKey === taSymbolsKey && (() => {
                            const ta = taMap[stock.symbol]
                            return ta ? (
                              <TaTag info={ta} onOpen={() => openDeepAnalysis(stock.id, stock.symbol, stock.name)} />
                            ) : (
                              <TaEmptyTag onOpen={() => openDeepAnalysis(stock.id, stock.symbol, stock.name)} />
                            )
                          })()}
                        </div>
                      </div>
                      <div className="text-right">
                        <div title={quoteHint(quote || {})} className={`font-mono text-[14px] font-bold leading-tight ${changeColor}`}>
                          {quote?.current_price != null ? formatQuotePrice(quote.current_price, stock.asset_type, stock.market) : '--'}
                        </div>
                        <div className={`font-mono text-[11px] leading-tight ${changeColor}`}>
                          {quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2">
                      {(suggestion || kline) ? (
                        <SuggestionBadge
                          suggestion={suggestion}
                          stockName={stock.name}
                          stockSymbol={stock.symbol}
                          kline={kline}
                          market={stock.market}
                          hasPosition={false}
                          onReEvaluated={() => loadPoolSuggestions()}
                        />
                      ) : (
                        <div className="text-[11px] text-muted-foreground/70 py-2">{stockT('stocksPage.messages.noAnalysis')}</div>
                      )}
                    </div>

                    <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {stock.agents && stock.agents.length > 0 ? (
                          <Badge variant="secondary" className="text-[10px]">{stockT('stocksPage.messages.agentCount', { count: stock.agents.length })}</Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground/60">{stockT('stocksPage.messages.notConfigured')}</span>
                        )}
                        {runningAgents[stock.id] && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                            <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            {agentName(runningAgents[stock.id] || '', agents.find(a => a.name === runningAgents[stock.id])?.display_name)}
                          </span>
                        )}
                      </div>
                      <div
                        className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openKlineDialog(stock.symbol, stock.market, stock.name, false)}
                          title={stockT('stocksPage.messages.klineIndicator')}
                        >
                          <BarChart3 className="w-3.5 h-3.5" />
                        </Button>
                        <StockPriceAlertPanel
                          mode="icon"
                          stockId={stock.id}
                          symbol={stock.symbol}
                          market={stock.market}
                          stockName={stock.name}
                          initialTotal={getPriceAlertSummary(stock.symbol, stock.market).total}
                          initialEnabled={getPriceAlertSummary(stock.symbol, stock.market).enabled}
                          onChanged={loadPriceAlertSummaries}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openNewsDialog(stock.name)}
                          title={stockT('stocksPage.messages.relatedNews')}
                        >
                          <Newspaper className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-primary"
                          title={stockT('stocksPage.messages.deepAnalysis')}
                          onClick={() => openDeepAnalysis(stock.id, stock.symbol, stock.name)}
                        >
                          <Brain className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openStockDetail(stock.symbol, stock.market, stock.name, false)}
                          title={stockT('stocksPage.messages.detail')}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => setRemoveWatchStock(stock)}
                          title={stockT('stocksPage.messages.deleteStock')}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Kline Dialog */}
      <KlineSummaryDialog
        open={klineDialogOpen}
        onOpenChange={setKlineDialogOpen}
        symbol={klineDialogSymbol}
        market={klineDialogMarket}
        stockName={klineDialogName}
        hasPosition={klineDialogHasPosition}
        initialSummary={klineDialogInitialSummary as any}
      />

      <StockInsightModal
        open={insightOpen}
        onOpenChange={setInsightOpen}
        symbol={insightSymbol}
        market={insightMarket}
        stockName={insightName}
        hasPosition={insightHasPosition}
        initialTab={insightInitialTab}
        onUziUpdated={loadUziMap}
      />

      {/* TradingAgents 深度分析弹窗 */}
      {deepAnalysisTarget && (
        <DeepAnalysisModal
          open={!!deepAnalysisTarget}
          onOpenChange={(open) => {
            if (!open) {
              // 关闭时刷新这一只的徽章:覆盖「刚跑完 / 刚强制重跑」的场景
              const symbol = deepAnalysisTarget?.symbol
              setDeepAnalysisTarget(null)
              if (symbol) void refreshTaForSymbol(symbol)
            }
          }}
          stockId={deepAnalysisTarget.stockId}
          stockSymbol={deepAnalysisTarget.symbol}
          stockName={deepAnalysisTarget.name}
        />
      )}

      {/* Remove Watchlist Dialog */}
      <Dialog open={!!removeWatchStock} onOpenChange={(open) => { if (!open) setRemoveWatchStock(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{stockT('stocksPage.messages.deleteStock')}</DialogTitle>
            <DialogDescription>{stockT('stocksPage.messages.deleteStockDescription')}</DialogDescription>
          </DialogHeader>
          {removeWatchStock && (
            <div className="space-y-4 mt-2">
              <div className="rounded-lg border border-border/40 bg-accent/20 p-3">
                <div className="text-[13px] font-semibold text-foreground">
                  {removeWatchStock.name}
                  <span className="ml-2 font-mono text-[12px] text-muted-foreground">{removeWatchStock.symbol}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  {hasAnyPositionForStockId(removeWatchStock.id)
                    ? stockT('stocksPage.messages.deleteStockWithPosition')
                    : stockT('stocksPage.messages.deleteStockWithoutPosition')}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRemoveWatchStock(null)} disabled={removingWatchStock}>{stockT('stocksPage.messages.cancel')}</Button>
                <Button
                  variant="destructive"
                  onClick={() => removeFromWatchlist(removeWatchStock)}
                  disabled={removingWatchStock || hasAnyPositionForStockId(removeWatchStock.id)}
                >
                  {hasAnyPositionForStockId(removeWatchStock.id) ? stockT('stocksPage.messages.deleteStockFirst') : (removingWatchStock ? stockT('stocksPage.messages.processing') : stockT('stocksPage.messages.deleteStock'))}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AccountDialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen} editing={!!editAccountId}
        value={accountForm} onChange={setAccountForm} onSubmit={handleAccountSubmit} />

      <PositionDialog
        positionDialogOpen={positionDialogOpen}
        setPositionDialogOpen={setPositionDialogOpen}
        editPositionId={editPositionId}
        positionForm={positionForm}
        setPositionForm={setPositionForm}
        accounts={accounts}
        positionDialogAccountId={positionDialogAccountId}
        positionSearchQuery={positionSearchQuery}
        setPositionSearchQuery={setPositionSearchQuery}
        positionSearchResults={positionSearchResults}
        setPositionSearchResults={setPositionSearchResults}
        showPositionDropdown={showPositionDropdown}
        setShowPositionDropdown={setShowPositionDropdown}
        positionSearchMarket={positionSearchMarket}
        setPositionSearchMarket={setPositionSearchMarket}
        positionSearching={positionSearching}
        positionDropdownRef={positionDropdownRef}
        handlePositionSearchMarketChange={handlePositionSearchMarketChange}
        handlePositionSearchInput={handlePositionSearchInput}
        selectPositionStock={selectPositionStock}
        handlePositionSubmit={handlePositionSubmit}
        marketBadge={marketBadge}
      />

      {/* Agent Assignment Dialog */}
      <Dialog open={!!agentDialogStock} onOpenChange={open => !open && setAgentDialogStock(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{stockT('stocksPage.messages.configureAgent')}</DialogTitle>
            <DialogDescription>
              {agentDialogStock?.name} ({agentDialogStock?.symbol})
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {agents.length === 0 ? (
              <p className="text-[13px] text-muted-foreground py-4 text-center">{stockT('stocksPage.messages.noAvailableAgents')}</p>
            ) : (
              agents.map(agent => {
                const stockAgent = agentDialogStock?.agents?.find(a => a.agent_name === agent.name)
                const isAssigned = !!stockAgent
                const isBatchMode = agent.execution_mode === 'batch'
                return (
                  <div key={agent.name} className="rounded-xl bg-accent/30 hover:bg-accent/50 transition-colors overflow-hidden">
                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-border'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{agentName(agent.name, agent.display_name)}</span>
                            <Badge variant="secondary" className="text-[9px]">
                              {isBatchMode ? stockT('stocksPage.messages.batch') : stockT('stocksPage.messages.single')}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{localizeAgentDescription(agent.name, agent.description, stockT)}</p>
                        </div>
                      </div>
                      <Switch
                        checked={isAssigned}
                        onCheckedChange={() => agentDialogStock && toggleAgent(agentDialogStock, agent.name)}
                        disabled={!agent.enabled}
                      />
                    </div>
                    {isAssigned && isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0">
                        <p className="text-[11px] text-muted-foreground">
                          {stockT('stocksPage.messages.agentConfigHint')}
                          <a href="/agents" className="text-primary hover:underline">{stockT('stocksPage.messages.configureAgent')}</a>
                        </p>
                      </div>
                    )}
                    {isAssigned && !isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0 space-y-2.5">
                        {/* Schedule/Interval Select */}
                        <div className="flex items-center gap-2">
                          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.schedule || '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentSchedule(agentDialogStock, agent.name, val === '__default__' ? '' : val)}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue placeholder={stockT('stocksPage.messages.executionInterval')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">{stockT('stocksPage.messages.followGlobal')}</SelectItem>
                              <SelectItem value="*/1 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 1 })}</SelectItem>
                              <SelectItem value="*/3 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 3 })}</SelectItem>
                              <SelectItem value="*/5 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 5 })}</SelectItem>
                              <SelectItem value="*/10 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 10 })}</SelectItem>
                              <SelectItem value="*/15 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 15 })}</SelectItem>
                              <SelectItem value="*/30 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 30 })}</SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.tradingHours')}</span>
                        </div>

                        {/* Schedule Preview */}
                        {(() => {
                          const eff = effectiveSchedule(agent, stockAgent)
                          const isFollowingGlobal = !(stockAgent?.schedule || '').trim() && !!(agent.schedule || '').trim()
                          const previewKey = `${agent.name}|${agentDialogStock?.market}|${eff}`
                          const preview = eff ? schedulePreviewCache[previewKey] : null
                          const isLoading = eff ? !!schedulePreviewLoading[previewKey] : false
                          if (!eff) return null
                          return (
                            <div className="ml-[22px] rounded-lg border border-border/40 bg-background/30 px-2.5 py-2">
                              <div className="flex items-center justify-between">
                                <div className="text-[11px] text-muted-foreground">
                                  {stockT('stocksPage.messages.nextRunPreview')}{isFollowingGlobal ? <span className="ml-1 opacity-70">({stockT('stocksPage.messages.followGlobalShort')})</span> : null}
                                </div>
                                {isLoading && (
                                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                )}
                              </div>
                              {'error' in (preview || {}) ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">{(preview as any).error}</div>
                              ) : (preview as SchedulePreview | undefined)?.next_runs?.length ? (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {(preview as SchedulePreview).next_runs.map((t, i) => (
                                    <span key={i} className="px-1.5 py-0.5 rounded border border-border/60 bg-accent/20 font-mono" title={t}>
                                      {formatPreviewTime(t)}
                                    </span>
                                  ))}
                                  {(preview as SchedulePreview).timezone ? (
                                    <span className="opacity-60">({browserTimezone()})</span>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="mt-1 text-[11px] text-muted-foreground">—</div>
                              )}
                              <div className="mt-1 text-[10px] text-muted-foreground/70 font-mono">schedule: {eff}<br />{stockT('configuration:agentsPage.schedule.timezoneHint', { timezone: (preview as SchedulePreview | null)?.timezone || '…' })}</div>
                            </div>
                          )
                        })()}

                        {/* AI Model Select */}
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.ai_model_id?.toString() ?? '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentModel(agentDialogStock, agent.name, val === '__default__' ? null : parseInt(val))}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">{stockT('stocksPage.messages.systemDefault')}</SelectItem>
                              {services.map(svc => (
                                <SelectGroup key={svc.id}>
                                  <SelectLabel>{svc.name}</SelectLabel>
                                  {svc.models.map(m => (
                                    <SelectItem key={m.id} value={m.id.toString()}>
                                      {m.name}{m.name !== m.model ? ` (${m.model})` : ''}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* Notification Channels */}
                        {channels.length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Bell className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            {channels.map(ch => {
                              const isSelected = (stockAgent?.notify_channel_ids || []).includes(ch.id)
                              return (
                                <button
                                  key={ch.id}
                                  onClick={() => agentDialogStock && toggleStockAgentChannel(agentDialogStock, agent.name, ch.id)}
                                  className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
                                    isSelected
                                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                                      : 'bg-accent/30 border-border/50 text-muted-foreground hover:border-primary/30'
                                  }`}
                                >
                                  {ch.name}
                                </button>
                              )
                            })}
                            {(stockAgent?.notify_channel_ids || []).length === 0 && (
                              <span className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.systemDefault')}</span>
                            )}
                          </div>
                        )}
                        {/* Trigger Button */}
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            variant="secondary" size="sm" className="h-7 text-[11px] px-2.5"
                            disabled={triggeringAgent === agent.name}
                            onClick={() => agentDialogStock && triggerStockAgent(agentDialogStock.id, agent.name)}
                          >
                            {triggeringAgent === agent.name ? (
                              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                              {stockT('stocksPage.messages.deepAnalysis')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Agent 分析结果弹窗 */}
      <Dialog open={!!agentResultDialog} onOpenChange={open => !open && setAgentResultDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{agentResultDialog?.title}</DialogTitle>
            <DialogDescription className="flex items-center gap-2 pt-1">
              {agentResultDialog?.should_alert ? (
                <Badge variant="default" className="text-[10px]">{stockT('stocksPage.messages.suggestedWatch')}</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">{stockT('stocksPage.messages.noAttention')}</Badge>
              )}
              {agentResultDialog?.notified && (
                <Badge variant="outline" className="text-[10px]">{stockT('stocksPage.messages.notificationSent')}</Badge>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 p-3 bg-accent/30 rounded-lg">
            <pre className="text-[13px] whitespace-pre-wrap font-sans leading-relaxed">
              {agentResultDialog?.content}
            </pre>
          </div>
          <div className="flex justify-end mt-2">
            <Button variant="outline" size="sm" onClick={() => setAgentResultDialog(null)}>
              {stockT('stocksPage.messages.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <NewsDialog open={newsDialogOpen} onOpenChange={setNewsDialogOpen} symbol={newsDialogSymbol}
        onSymbolChange={setNewsDialogSymbol} loading={newsLoading} news={news} stocks={stocks} onLoad={loadNews} />

    </div>
  )
}
