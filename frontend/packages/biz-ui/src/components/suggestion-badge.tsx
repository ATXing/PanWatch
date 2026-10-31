import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@panwatch/base-ui/components/ui/tabs'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { KlineSummaryDialog } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { KlineIndicators, hitIndicatorLabels } from '@panwatch/biz-ui/components/kline-indicators'
import { buildKlineSuggestion, KLINE_SCORE_LIMIT } from '@/lib/kline-scorer'
import { AiSuggestionBadge } from '@panwatch/biz-ui/components/ai-suggestion-badge'
import { TechnicalBadge, technicalToneFromSuggestionAction } from '@panwatch/biz-ui/components/technical-badge'
import { useTranslation } from 'react-i18next'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { insightApi, stocksApi } from '@panwatch/api'
import { isSameMarketDay } from '@/lib/market-time'
import { suggestionPresentation, type SuggestionStateInput } from './suggestion-action'
import { wrapForTitle } from '@panwatch/biz-ui/lib/title-wrap'

/**
 * TradingAgents 也往建议池写（`tradingagents/agent.py` + 启动回填），有效期 24h 比盘前/盘中/盘后都长，
 * 因此常按 MAX(id) 顶掉徽章。详情弹窗据此把「深度分析」和三个 workflow agent 分成两个 tab。
 */
const TA_AGENT = 'tradingagents'

export interface SuggestionInfo extends SuggestionStateInput {
  id?: number
  action: string  // buy/add/reduce/sell/hold/watch
  action_label: string
  signal: string
  reason: string
  should_alert: boolean
  raw?: string
  // 建议池新增字段
  agent_name?: string     // intraday_monitor/daily_report/premarket_outlook/tradingagents
  agent_label?: string    // 盘中监测/盘后日报/盘前分析
  created_at?: string     // ISO 时间戳
  expires_at?: string | null  // 过期时间：去重命中时只延长该值，用于判断「结论未变」
  is_expired?: boolean    // 是否已过期
  prompt_context?: string // Prompt 上下文
  ai_response?: string    // AI 原始响应
  meta?: Record<string, any>
}

export interface KlineSummary {
  // meta (from backend)
  timeframe?: string
  computed_at?: string
  asof?: string
  params?: Record<string, any>

  trend: string
  macd_status: string
  macd_cross?: string
  macd_cross_days?: number
  recent_5_up: number
  change_5d: number | null
  change_20d: number | null
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma60?: number | null
  // RSI
  rsi6?: number | null
  rsi_status?: string
  // KDJ
  kdj_k?: number | null
  kdj_d?: number | null
  kdj_j?: number | null
  kdj_status?: string
  // 布林带
  boll_upper?: number | null
  boll_mid?: number | null
  boll_lower?: number | null
  boll_status?: string
  // 量能
  volume_ratio?: number | null
  volume_trend?: string
  // 振幅
  amplitude?: number | null
  // 多级支撑压力
  support: number | null
  resistance: number | null
  support_s?: number | null
  support_m?: number | null
  resistance_s?: number | null
  resistance_m?: number | null
  // K线形态
  kline_pattern?: string
}

interface SuggestionBadgeProps {
  suggestion: SuggestionInfo | null
  stockName?: string
  stockSymbol?: string
  kline?: KlineSummary | null
  showFullInline?: boolean  // 是否在行内显示完整信息（Dashboard 模式）
  market?: string           // 市场（用于技术指标弹窗）
  hasPosition?: boolean     // 是否持仓（用于技术指标弹窗）
  showTechnicalCompanion?: boolean // 是否展示技术指标对照徽章
  /** 重新评估成功后回调，外层据此刷新建议池让徽章更新 */
  onReEvaluated?: () => void | Promise<void>
  /** 是否展示「重新评估」入口（默认展示；纯技术指标徽章无 agent 时内部也会隐藏） */
  allowReEvaluate?: boolean
}

/**
 * 徽章下方的时间戳：固定输出「10/24 11:04」。
 * 用本地时间 getter 逐段拼，不切 ISO 字符串、不写死 timeZone，
 * 也不受 locale 里「2026年10月24日」这类格式差异影响（徽章空间只够这一种紧凑写法）。
 */
export function formatShortInstant(isoTime?: string | null): string {
  if (!isoTime) return ''
  const date = new Date(isoTime)
  if (isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 格式化建议时间（自动转换为本地时区，只显示时:分）
function formatSuggestionTime(isoTime?: string, locale = 'zh-CN'): string {
  if (!isoTime) return ''
  try {
    const date = new Date(isoTime)
    // 检查日期是否有效
    if (isNaN(date.getTime())) return ''
    // 使用本地时区显示
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return ''
  }
}

// 格式化完整日期时间（本地时区）
function formatSuggestionDateTime(isoTime?: string, locale = 'zh-CN'): string {  if (!isoTime) return ''
  try {
    const date = new Date(isoTime)
    if (isNaN(date.getTime())) return ''
    return date.toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return ''
  }
}


function formatKlineMeta(meta: Record<string, any> | undefined, locale: string, tr: (key: string, options?: Record<string, unknown>) => string): string {
  if (!meta) return ''
  const computedAt = meta?.kline_meta?.computed_at
  const asof = meta?.kline_meta?.asof
  const parts: string[] = []
  if (asof) parts.push(tr('klineAsOf', { value: asof }))
  if (computedAt) parts.push(tr('calculated', { value: formatSuggestionTime(computedAt, locale) }))
  return parts.join(' · ')
}

export function SuggestionBadge({
  suggestion,
  stockName,
  stockSymbol,
  kline,
  showFullInline = false,
  market = 'CN',
  hasPosition = false,
  showTechnicalCompanion = true,
  onReEvaluated,
  allowReEvaluate = true,
}: SuggestionBadgeProps) {
  const { t, i18n } = useTranslation('bizUi')
  const { toast } = useToast()
  const tr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(`suggestionBadge.${key}`, options)
  const klineTr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(`kline.${key}`, options)
  const locale = (i18n.resolvedLanguage || i18n.language).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
  const english = locale === 'en-US'
  const isTechnical = suggestion?.agent_name === 'technical_fallback' || suggestion?.agent_label === '技术指标'
  // tradingagents 也登记进来：它同样往建议池写（有效期 24h），徽章下那行才不会顶着
  // 「TradingAgents 深度」这么长的来源名，弹窗 tab 也能复用同一个短名
  const knownAgents = new Set(['intraday_monitor', 'daily_report', 'premarket_outlook', 'technical_fallback', TA_AGENT])
  const localizedAgent = suggestion?.agent_name && knownAgents.has(suggestion.agent_name)
    ? tr(`agents.${suggestion.agent_name}`)
    : english
      ? suggestion?.agent_name || tr('unknown')
      : suggestion?.agent_label || suggestion?.agent_name || tr('unknown')
  // 徽章下方只有 10px 一行位置：来源用两字简称（盘前/盘中/盘后），时间只留「MM/DD HH:mm」，
  // 过期时追加「过期」两字，不过期不写（不再用「来源：…（已过期）」这种占宽最大的写法）
  const shortAgent = suggestion?.agent_name && knownAgents.has(suggestion.agent_name)
    ? tr(`agentsShort.${suggestion.agent_name}`)
    : localizedAgent
  const localizedAction = (action?: string, label?: string) => (t as unknown as (key: string) => string)(suggestionPresentation({ action, action_label: label }).labelKey)
  // 技术动作后面挂评分：分数是 kline-scorer 各指标累加值（0 为中性，正偏多、负偏空），
  // 只做展示，不改档位判定阈值。徽章上写强度绝对值（方向已由动作表达，避免「减仓·-2分」双负号），
  // 带符号的净值留给悬停明细；0 分不写，避免「观望·0分」这种废话标签。
  const technicalLabel = (tech: ReturnType<typeof buildKlineSuggestion> | null) => tech
    ? `${localizedAction(tech.action, tech.action_label)}${tech.score ? tr('scoreSuffix', { value: Math.abs(tech.score) }) : ''}`
    : tr('technicalPending')
  // 悬停看这分为哪来：逐项 +/- 明细，避免「5 分」变成不可追溯的黑箱数字
  // 首行带上限（±9），否则「9 分」看不出是不是封顶了
  const technicalTip = (tech: ReturnType<typeof buildKlineSuggestion> | null) => {
    if (!tech) return tr('technicalTitle')
    const lines = tech.evidence.map(e => `${e.delta > 0 ? '+' : ''}${e.delta} ${e.text}`)
    return [tr('technicalTitle'), tr('scoreTotal', { value: tech.score, max: KLINE_SCORE_LIMIT }), ...lines].join('\n')
  }
  // AI 徽章的悬停：信号 + 理由摘要 + 命中的技术指标 + 支撑/压力。
  // 来源和时间在徽章下方那行 10px 小字里已经有了，不重复占用提示框；
  // 全部为空时回退成原来那句「点击查看建议详情」，避免出现空 tooltip。
  const aiHoverTip = (s: SuggestionInfo): string => {
    const lines: string[] = []
    const signal = (s.signal || '').trim()
    if (signal) lines.push(tr('hoverSignal', { value: signal }))
    const body = wrapForTitle((s.reason || '').trim(), english ? 60 : 36)
    if (body.length) {
      const sep = english ? ': ' : '：'
      lines.push(`${tr('reason')}${sep}${body[0]}`, ...body.slice(1))
    }
    if (kline) {
      // 技术指标只列详情页里「不是灰色」的那几枚（RSI 超买 / BOLL 突破上轨 / 大阳线 …），
      // 与打分引擎的加减分明细无关——那是另一套口径，混进来会让人以为分数就是这么加出来的。
      // 一枚都没命中就整块省略，不写「无命中」占位。
      const hits = hitIndicatorLabels(kline as any, klineTr, english)
      if (hits.length) {
        if (lines.length) lines.push('')
        // 按「一枚徽章」整块折行，不按字符硬切——否则「BOLL 突破上轨」会被劈成「BOL / L 突破上轨」。
        // 前缀占掉第一行一部分宽度，所以每行可用宽度要先减掉它。
        const prefix = tr('hoverTechHits')
        const width = Math.max(16, (english ? 60 : 36) - prefix.length)
        const rows: string[] = []
        let row = ''
        for (const hit of hits) {
          const next = row ? `${row} · ${hit}` : hit
          if (row && next.length > width) {
            rows.push(row)
            row = hit
          } else {
            row = next
          }
        }
        if (row) rows.push(row)
        lines.push(`${prefix}${rows[0]}`, ...rows.slice(1))
      }
      const support = kline.support
      const resistance = kline.resistance
      if (support != null || resistance != null) {
        lines.push(tr('hoverLevels', {
          support: support != null ? support.toFixed(2) : '—',
          resistance: resistance != null ? resistance.toFixed(2) : '—',
        }))
      }
    }
    if (!lines.length) return tr('detailTitle')
    lines.push(tr('detailTitle'))
    return lines.join('\n')
  }
  const [dialogOpen, setDialogOpen] = useState(false)
  const [klineDialogOpen, setKlineDialogOpen] = useState(false)
  // 建议池列表接口每票只回一条（MAX(id)），TA 与三个 workflow agent 会互相顶掉。
  // 弹窗打开时再拉一次单票历史，两侧各留最新一条 → 分成两个 tab，旧结论不至于看不到。
  const [taSide, setTaSide] = useState<SuggestionInfo | null>(null)
  const [workflowSide, setWorkflowSide] = useState<SuggestionInfo | null>(null)
  const [activeTab, setActiveTab] = useState<'workflow' | 'ta'>('workflow')

  // ---- 重新评估：手动重跑产生这条徽章的 AI agent（盘前/盘中/盘后） ----
  // 语义：原结果是「当天」的 → 弹窗主区保持不动，按钮下方追加「最新结果」对比卡；
  //       原结果非当天 → 主区直接替换；去重未产生新行 → 显示「结论未变」。
  const REEVAL_POLL_MS = 5000
  const REEVAL_TIMEOUT_MS = 90_000
  const [reevaluating, setReevaluating] = useState(false)
  // 打开弹窗时锁定的「原结果」：主区始终展示它，不被建议池刷新替换
  const [pinned, setPinned] = useState<SuggestionInfo | null>(null)
  const [compare, setCompare] = useState<
    | { kind: 'new'; item: SuggestionInfo }
    | { kind: 'unchanged' }
    | { kind: 'timeout' }
    | null
  >(null)
  const [compareExpanded, setCompareExpanded] = useState(false)
  const reevalPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reevalSnapRef = useRef<{
    agent: string
    market: string
    sameDay: boolean
    baseId?: number
    baseExpiresAt?: string | null
    startedAt: number
  } | null>(null)
  const stopReevalPoll = () => {
    if (reevalPollRef.current != null) {
      clearInterval(reevalPollRef.current)
      reevalPollRef.current = null
    }
  }
  useEffect(() => () => stopReevalPoll(), [])

  // 打开详情弹窗时锁定「当前看到的那条」作为主区内容；关闭后重开会重新锁定最新一条。
  // 只依赖 dialogOpen：建议池在弹窗开着时刷新不会误触发重新锁定。
  useEffect(() => {
    if (!dialogOpen) return
    setPinned(suggestion)
    // 默认 tab 跟随徽章：徽章上是 TA 就开 TA，避免「点进去看到的结论和徽章不一样」。
    // 必须放在这里而不是 onDialogOpenChange——徽章点击是直接 setDialogOpen(true)，
    // Radix 的 onOpenChange 并不会被调用。
    setActiveTab(suggestion?.agent_name === TA_AGENT ? 'ta' : 'workflow')
    if (!reevaluating) {
      setCompare(null)
      setCompareExpanded(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen])

  // 打开弹窗时补拉「另一侧」：单票历史接口已能返回该票多个 agent 的记录，不必动后端。
  // 取数失败就两个都置空 ⇒ 不显示 tab、完全退化成原来的单页，不能让网络问题挡住弹窗。
  useEffect(() => {
    if (!dialogOpen) return
    // 没有 agent 来源（纯技术指标徽章）就没有「另一侧」可分，不必多发一次请求
    if (!stockSymbol || !suggestion?.agent_name) {
      setTaSide(null)
      setWorkflowSide(null)
      return
    }
    let cancelled = false
    const symbol = stockSymbol
    const mk = market || 'CN'
    void (async () => {
      try {
        const list = await insightApi.suggestions<SuggestionInfo[]>(symbol, {
          market: mk,
          limit: 20,
          include_expired: true,
        })
        if (cancelled) return
        const pick = (pred: (s: SuggestionInfo) => boolean) =>
          (list || []).filter(pred).sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] || null
        setTaSide(pick((s) => s.agent_name === TA_AGENT))
        setWorkflowSide(
          pick((s) => !!s.agent_name && s.agent_name !== TA_AGENT && s.agent_name !== 'technical_fallback'),
        )
      } catch {
        if (cancelled) return
        setTaSide(null)
        setWorkflowSide(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // 只随「打开」与标的切换重取：建议池在弹窗开着时刷新不该重拉，也不该覆盖已锁定的两侧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, stockSymbol, market])

  // 徽章本身是不是 TA 那侧：只用来决定默认打开哪个 tab
  const badgeIsTa = suggestion?.agent_name === TA_AGENT
  const badgeTab: 'workflow' | 'ta' = badgeIsTa ? 'ta' : 'workflow'
  // 「重新评估」只重跑盘前/盘中/盘后这类 workflow agent，与 TradingAgents 没有任何关系：
  // 徽章是 TA 时落到另一侧那条 workflow 结论上（弹窗里就在「AI 建议」tab 下）；
  // 该票压根没有 workflow 结论时就无可重跑对象，按钮不出现（TA 重跑走 Agent 页 / 🧠 入口）。
  const workflowSideAgent = workflowSide?.agent_name
    || (suggestion?.agent_name && suggestion.agent_name !== TA_AGENT ? suggestion.agent_name : null)
  const agentForReeval = workflowSideAgent
  const canReevaluate = allowReEvaluate && !!agentForReeval && !!stockSymbol && !isTechnical

  // 按 agent 过滤取该票该 agent 的最新一条：建议池接口只给「每票一条」（max id），
  // 而 max id 可能是别的 agent，所以这里按 agent 单独探测。
  const probeLatest = async (agent: string, symbol: string, mk: string): Promise<SuggestionInfo | null> => {
    try {
      const list = await insightApi.suggestions<SuggestionInfo[]>(symbol, {
        market: mk,
        limit: 20,
        include_expired: true,
      })
      return (list || [])
        .filter((item) => item.agent_name === agent)
        .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] || null
    } catch {
      return null
    }
  }

  const finishReeval = (next: typeof compare) => {
    stopReevalPoll()
    setReevaluating(false)
    setCompare(next)
  }

  const handleReevaluate = async () => {
    if (!canReevaluate || reevaluating) return
    const mk = market || 'CN'
    const agent = agentForReeval!
    // 基线取「AI 建议」那一侧：徽章是 TA 时 pinned 锁的是 TA，不能拿它判当天/取 id
    const base = workflowSide
      || (suggestion && suggestion.agent_name !== TA_AGENT ? suggestion : null)
    setReevaluating(true)
    setCompare(null)
    setCompareExpanded(false)

    const baseline = await probeLatest(agent, stockSymbol!, mk)
    reevalSnapRef.current = {
      agent,
      market: mk,
      sameDay: isSameMarketDay(base?.created_at, mk),
      baseId: baseline?.id ?? base?.id,
      baseExpiresAt: baseline?.expires_at,
      startedAt: Date.now(),
    }

    try {
      // stock_id=0 + allow_unbound：详情弹窗按 symbol/market 单只触发，不依赖是否已绑定 agent。
      // bypass_throttle/market_hours：手动触发不该被节流或交易时段门禁挡掉。
      await stocksApi.triggerAgent(0, agent, {
        allow_unbound: true,
        symbol: stockSymbol,
        market: mk,
        name: stockName || stockSymbol,
        bypass_throttle: true,
        bypass_market_hours: true,
        force_refresh: true,
      })
      toast(tr('reevaluate.queued'), 'success')

      const tick = async () => {
        const snap = reevalSnapRef.current
        if (!snap) return
        if (Date.now() - snap.startedAt > REEVAL_TIMEOUT_MS) {
          finishReeval({ kind: 'timeout' })
          return
        }
        try { await onReEvaluated?.() } catch { /* 忽略单次刷新失败 */ }
        const latest = await probeLatest(snap.agent, stockSymbol!, snap.market)
        if (!latest) return
        const isNew = snap.baseId != null && latest.id != null && latest.id > snap.baseId
        if (isNew) {
          if (snap.sameDay) {
            finishReeval({ kind: 'new', item: latest })
          } else {
            // 徽章是 TA 时 pinned 锁的是 TA 那条，重跑的是 AI 建议侧 ⇒ 更新那一侧的数据
            if (badgeTab === 'ta') setWorkflowSide(latest)
            else setPinned(latest)
            finishReeval(null)
            toast(tr('reevaluate.replaced'), 'success')
          }
          return
        }
        // 去重命中：id / created_at 不变，只有 expires_at 被延长
        const baseExp = snap.baseExpiresAt
        const latestExp = latest.expires_at
        const extended = !!baseExp && !!latestExp && Date.parse(latestExp) - Date.parse(baseExp) >= 1000
        if (extended) finishReeval({ kind: 'unchanged' })
      }

      stopReevalPoll()
      reevalPollRef.current = setInterval(() => { void tick() }, REEVAL_POLL_MS)
      void tick()
    } catch (e) {
      stopReevalPoll()
      setReevaluating(false)
      toast(tr('reevaluate.failed', { message: e instanceof Error ? e.message : '' }), 'error')
    }
  }

  const reevaluateButton = canReevaluate ? (
    <div className="pt-3 border-t border-border/30">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={reevaluating}
        onClick={handleReevaluate}
      >
        <RotateCw className={`w-3.5 h-3.5 mr-1.5 ${reevaluating ? 'animate-spin' : ''}`} />
        {reevaluating ? tr('reevaluate.reevaluating') : tr('reevaluate.button')}
      </Button>
      <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
        {tr('reevaluate.hint')}
      </p>
    </div>
  ) : null

  // 重跑结果：当天原结果留在主区，这里显示本次重跑得到的最新结果 / 结论未变 / 超时
  const compareCard = compare ? (
    <div className="mt-2 rounded-md border border-border/40 bg-accent/20 p-2.5">
      {compare.kind === 'new' ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">{tr('reevaluate.latestTitle')}</span>
            <span className="text-[10px] text-muted-foreground/70">
              {formatSuggestionDateTime(compare.item.created_at, locale)}
            </span>
          </div>
          <div className="mt-1 text-[12px] font-medium text-foreground">
            {localizedAction(compare.item.action, compare.item.action_label)}
            {compare.item.signal && (
              <span className="ml-1.5 font-normal text-muted-foreground">{compare.item.signal}</span>
            )}
          </div>
          <p className={`mt-0.5 text-[11px] text-muted-foreground ${compareExpanded ? '' : 'line-clamp-2'}`}>
            {compare.item.reason || compare.item.raw || ''}
          </p>
          {compareExpanded && compare.item.ai_response && (
            <div className="mt-2 max-h-40 overflow-y-auto scrollbar whitespace-pre-wrap rounded bg-accent/30 p-2 text-[11px] text-foreground">
              {compare.item.ai_response}
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground/70">{tr('reevaluate.latestNote')}</span>
            <button
              type="button"
              className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setCompareExpanded(v => !v)}
            >
              {compareExpanded ? tr('reevaluate.collapse') : tr('reevaluate.expandFull')}
            </button>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {compare.kind === 'unchanged' ? tr('reevaluate.unchanged') : tr('reevaluate.timeout')}
          </span>
          {compare.kind === 'unchanged' && (
            <span className="ml-1.5">{tr('reevaluate.unchangedHint')}</span>
          )}
        </div>
      )}
    </div>
  ) : null

  const onDialogOpenChange = (open: boolean) => {
    setDialogOpen(open)
    if (open) {
      // 锁定「打开弹窗时看到的那条」作为主区内容
      setPinned(suggestion)
      if (!reevaluating) {
        setCompare(null)
        setCompareExpanded(false)
      }
      return
    }
    try {
      ;(window as any).__panwatch_suppress_card_click_until = Date.now() + 600
    } catch {
      // ignore
    }
  }

  if (!suggestion && !kline) return null

  // Dashboard 模式：行内显示完整信息（仅建议 badge）
  if (showFullInline) {
    if (!suggestion) return null
    const isAI = !!suggestion.agent_name && !isTechnical
    const tech = kline ? buildKlineSuggestion(kline as any, hasPosition, klineTr) : null
    const timeStr = formatSuggestionTime(suggestion.created_at, locale)
    const klineMetaStr = formatKlineMeta(suggestion.meta, locale, tr)
    return (
      <>
        <div className="pt-3 border-t border-border/30">
          <div className="flex items-start gap-3">
            <div className="shrink-0 flex items-center gap-2">
              <AiSuggestionBadge
                {...suggestion}
                action={suggestion.action}
                actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
                isAI={isAI}
                isExpired={!!suggestion.is_expired}
                size="lg"
                onClick={(e) => {
                  e.stopPropagation()
                  if (isTechnical) setKlineDialogOpen(true)
                  else setDialogOpen(true)
                }}
                title={aiHoverTip(suggestion)}
              />
              {isAI && showTechnicalCompanion && (
                <TechnicalBadge
                  label={`${tr('technicalShort')} · ${technicalLabel(tech)}`}
                  tone={tech ? technicalToneFromSuggestionAction(tech.action, tech.action_label) : 'neutral'}
                  size="lg"
                  onClick={(e) => { e.stopPropagation(); setKlineDialogOpen(true) }}
                  title={technicalTip(tech)}
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {suggestion.signal && (
                <p className="text-[12px] font-medium text-foreground mb-0.5">{suggestion.signal}</p>
              )}
              {suggestion.reason ? (
                <p className="text-[11px] text-muted-foreground">{suggestion.reason}</p>
              ) : suggestion.raw && !suggestion.signal ? (
                <p className="text-[11px] text-muted-foreground">{suggestion.raw}</p>
              ) : null}

              {(suggestion.agent_label || timeStr) && (
                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {tr('source')}{localizedAgent || (isAI ? 'AI' : tr('unknown'))}
                  {timeStr && ` · ${timeStr}`}
                  {suggestion.is_expired && <span className="ml-1 text-amber-600">{tr('expired')}</span>}
                </div>
              )}

              {klineMetaStr && (
                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {klineMetaStr}
                </div>
              )}
            </div>
          </div>
        </div>

        <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
          <DialogContent
            className="max-w-md"
            onPointerDownOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
            onInteractOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
            onClick={(e) => e.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AiSuggestionBadge
                  {...suggestion}
                  action={suggestion.action}
                  actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
                  isAI={isAI}
                  isExpired={!!suggestion.is_expired}
                  size="lg"
                />
                {stockName && (
                  <span className="text-[14px] font-normal text-muted-foreground">
                    {stockName} {stockSymbol && `(${stockSymbol})`}
                  </span>
                )}
              </DialogTitle>
              {/* 来源信息 */}
              {(suggestion.agent_label || suggestion.created_at) && (
                <div className="text-[11px] text-muted-foreground/70 mt-1">
                  {tr('source')}{localizedAgent}
                  {suggestion.created_at && ` · ${formatSuggestionDateTime(suggestion.created_at, locale)}`}
                  {suggestion.is_expired && <span className="ml-2 text-amber-500">{tr('expired')}</span>}
                </div>
              )}
            </DialogHeader>

            <div className="space-y-4">

              {/* 信号 */}
              {suggestion.signal && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('signal')}</div>
                  <p className="text-[13px] font-medium text-foreground">{suggestion.signal}</p>
                </div>
              )}

              {/* 理由 */}
              {(suggestion.reason || suggestion.raw) && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('reason')}</div>
                  <p className="text-[13px] text-foreground">
                    {suggestion.reason || suggestion.raw}
                  </p>
                </div>
              )}

              {/* 技术指标 */}
              {kline && (
                <div className="space-y-3">
                  <div className="text-[11px] text-muted-foreground">{tr('technical')}</div>
                  <KlineIndicators summary={kline as any} />
                </div>
              )}

              {/* AI 原始响应 */}
              {suggestion.ai_response && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('aiResponse')}</div>
                  <div className="text-[12px] text-foreground whitespace-pre-wrap bg-accent/30 rounded p-2 max-h-32 overflow-y-auto scrollbar">
                    {suggestion.ai_response}
                  </div>
                </div>
              )}

              {/* Prompt 上下文 */}
              {suggestion.prompt_context && (
                <details className="group">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                    {tr('promptContext')} <span className="text-[10px]">{tr('expand')}</span>
                  </summary>
                  <div className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap bg-accent/20 rounded p-2 max-h-48 overflow-y-auto scrollbar">
                    {suggestion.prompt_context}
                  </div>
                </details>
              )}
              {/* 该分支没有 tab，展示的就是 suggestion 本身；若它是 TA，界面整体算 TA 的，
                  不给「重新评估」（那是盘前/盘中/盘后的入口，重跑不到 TA） */}
              {!badgeIsTa && reevaluateButton}
            </div>
          </DialogContent>
        </Dialog>
        <KlineSummaryDialog
          open={klineDialogOpen}
          onOpenChange={setKlineDialogOpen}
          symbol={stockSymbol || ''}
          market={market}
          stockName={stockName}
          hasPosition={hasPosition}
          initialSummary={kline as any}
        />
      </>
    )
  }

  // 仅展示技术指标（无建议）
  if (!suggestion && kline) {
    const tech = buildKlineSuggestion(kline as any, hasPosition, klineTr)
    // 指标算出来的时刻：后端 kline_collector 写 computed_at（UTC 带时区）
    const techTime = formatShortInstant(kline.computed_at)
    return (
      <>
        <div className="inline-flex flex-col items-start gap-0.5">
          <TechnicalBadge
            label={technicalLabel(tech)}
            tone={technicalToneFromSuggestionAction(tech.action, tech.action_label)}
            size="md"
            onClick={(e) => {
              e.stopPropagation()
              setKlineDialogOpen(true)
            }}
            title={technicalTip(tech)}
          />
          {techTime && (
            <div className="text-[10px] leading-none text-muted-foreground/70">{techTime}</div>
          )}
        </div>

        <KlineSummaryDialog
          open={klineDialogOpen}
          onOpenChange={setKlineDialogOpen}
          symbol={stockSymbol || ''}
          market={market || 'CN'}
          stockName={stockName}
          hasPosition={hasPosition}
          initialSummary={kline as any}
        />
      </>
    )
  }

  if (!suggestion) return null
  const isAI = !!suggestion.agent_name && !isTechnical

  // 弹窗主区展示「打开时锁定的原结果」；徽章本体仍用 suggestion（始终显示最新一条）
  // 两侧都有（TA + 任一 workflow agent）时才出 tab：默认跟随徽章那侧，另一侧给旧结论留个入口。
  // 只有一侧时保持原样（单页、无 tab），不制造多余点击。
  const showTabs = !!taSide && !!workflowSide
  const sideFor = (tab: 'workflow' | 'ta') => (tab === 'ta' ? taSide : workflowSide)
  const shown = (showTabs
    ? activeTab === badgeTab
      ? pinned || sideFor(activeTab)
      : sideFor(activeTab)
    : pinned || suggestion) as SuggestionInfo
  const shownIsTechnical = shown.agent_name === 'technical_fallback' || shown.agent_label === '技术指标'
  const shownIsAI = !!shown.agent_name && !shownIsTechnical
  const shownAgent = shown.agent_name && knownAgents.has(shown.agent_name)
    ? tr(`agents.${shown.agent_name}`)
    : english
      ? shown.agent_name || tr('unknown')
      : shown.agent_label || shown.agent_name || tr('unknown')

  // 持仓页模式：小徽章 + 点击弹窗
  // 时间统一用「10/24 11:04」：徽章下只有一行位置，不带日期就分不清「今天刚跑」和「上周的」
  const timeShort = formatShortInstant(suggestion.created_at)
  const techTimeShort = formatShortInstant(kline?.computed_at)
  // 一行压到最短：「盘前·10/24 11:04」，过期时行尾再加「过期」
  const badgeStamp = isAI
    ? [shortAgent, timeShort].filter(Boolean).join('·')
    : timeShort

  return (
    <>
      {/* gap-2（8px）：AI 与「指标」两栈之间原来是 4px，两枚徽章下的时间戳
          （「…过期」紧接「10/24 12:53」）几乎粘连，加宽后各自留出呼吸位 */}
      <div className="inline-flex items-start gap-2">
        <div className="inline-flex flex-col items-start gap-0.5">
          <AiSuggestionBadge
            {...suggestion}
            action={suggestion.action}
            actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
            isAI={isAI}
            isExpired={!!suggestion.is_expired}
            size="md"
            onClick={(e) => {
              e.stopPropagation()
              if (isTechnical) setKlineDialogOpen(true)
              else setDialogOpen(true)
            }}
            title={aiHoverTip(suggestion)}
          />
          {/* 来源和时间（显示在徽章正下方，与右侧技术徽章的时间各自对齐）*/}
          {badgeStamp && (
            <div className="text-[10px] leading-none whitespace-nowrap text-muted-foreground/70">
              {badgeStamp}
              {suggestion.is_expired && <span className="ml-1 text-amber-600">{tr('expiredShort')}</span>}
            </div>
          )}
        </div>
        {showTechnicalCompanion && !isTechnical && (
          (() => {
            const tech = kline ? buildKlineSuggestion(kline as any, hasPosition, klineTr) : null
            return (
              <div className="inline-flex flex-col items-start gap-0.5">
                <TechnicalBadge
                  label={`${tr('technicalShort')} · ${technicalLabel(tech)}`}
                  tone={tech ? technicalToneFromSuggestionAction(tech.action, tech.action_label) : 'neutral'}
                  size="md"
                  onClick={(e) => { e.stopPropagation(); setKlineDialogOpen(true) }}
                  title={technicalTip(tech)}
                />
                {techTimeShort && (
                  <div className="text-[10px] leading-none text-muted-foreground/70">{techTimeShort}</div>
                )}
              </div>
            )
          })()
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent
          className="max-w-md"
          onPointerDownOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
          onInteractOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AiSuggestionBadge
                {...shown}
                action={shown.action}
                actionLabel={localizedAction(shown.action, shown.action_label)}
                isAI={shownIsAI}
                isExpired={!!shown.is_expired}
                size="md"
              />
              {stockName && (
                <span className="text-[14px] font-normal text-muted-foreground">
                  {stockName} {stockSymbol && `(${stockSymbol})`}
                </span>
              )}
            </DialogTitle>
            {/* 来源信息 */}
            {(shown.agent_label || shown.created_at) && (
              <div className="text-[11px] text-muted-foreground/70 mt-1">
                {tr('source')}{shownAgent}
                {shown.created_at && ` · ${formatSuggestionDateTime(shown.created_at, locale)}`}
                {shown.is_expired && <span className="ml-2 text-amber-500">{tr('expired')}</span>}
              </div>
            )}
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'workflow' | 'ta')}>
            {/* 只有 TA 与 workflow 两条都在时才出 tab；只有一条就保持原来的单页 */}
            {showTabs && (
              <TabsList>
                {/* 名字固定成「AI 建议 / TA」：这一侧装的是盘前/盘中/盘后任一条最新建议，
                    拿某一条的短名当 tab 名会在不同时点变成盘前/盘后，看着像 tab 会自己变 */}
                <TabsTrigger value="workflow">{tr('tabs.workflow')}</TabsTrigger>
                <TabsTrigger value="ta">{tr('tabs.ta')}</TabsTrigger>
              </TabsList>
            )}
            <TabsContent value={activeTab} className="mt-0">
              <div className="space-y-4">

                {/* 信号 */}
                {shown.signal && (
                  <div>
                    <div className="text-[11px] text-muted-foreground mb-1">{tr('signal')}</div>
                    <p className="text-[13px] font-medium text-foreground">{shown.signal}</p>
                  </div>
                )}

                {/* 理由 */}
                {(shown.reason || shown.raw) && (
                  <div>
                    <div className="text-[11px] text-muted-foreground mb-1">{tr('reason')}</div>
                    <p className="text-[13px] text-foreground">
                      {shown.reason || shown.raw}
                    </p>
                  </div>
                )}

                {/* 技术指标 */}
                {kline && (
                  <div className="space-y-3">
                    <div className="text-[11px] text-muted-foreground">{tr('technical')}</div>
                    <KlineIndicators summary={kline as any} />
                  </div>
                )}

                {/* AI 原始响应 */}
                {shown.ai_response && (
                  <div>
                    <div className="text-[11px] text-muted-foreground mb-1">{tr('aiResponse')}</div>
                    <div className="text-[12px] text-foreground whitespace-pre-wrap bg-accent/30 rounded p-2 max-h-32 overflow-y-auto scrollbar">
                      {shown.ai_response}
                    </div>
                  </div>
                )}

                {/* Prompt 上下文 */}
                {shown.prompt_context && (
                  <details className="group">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                      {tr('promptContext')} <span className="text-[10px]">{tr('expand')}</span>
                    </summary>
                    <div className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap bg-accent/20 rounded p-2 max-h-48 overflow-y-auto scrollbar">
                      {shown.prompt_context}
                    </div>
                  </details>
                )}
                {/* 重新评估只属于「AI 建议」这一侧（跑的是盘前/盘中/盘后 agent）。
                    TA tab 是纯展示：TradingAgents 的重跑入口在 🧠 深度分析弹窗（缓存横幅里的
                    「忽略缓存重新分析」）与 Agent 页，这里不放，免得同一件事两个入口 */}
                {activeTab === 'workflow' && reevaluateButton}
                {activeTab === 'workflow' && compareCard}
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      {/* Always mount K-line dialog for technical details */}
      <KlineSummaryDialog
        open={klineDialogOpen}
        onOpenChange={setKlineDialogOpen}
        symbol={stockSymbol || ''}
        market={market}
        stockName={stockName}
        hasPosition={hasPosition}
        initialSummary={kline as any}
      />
    </>
  )
}
