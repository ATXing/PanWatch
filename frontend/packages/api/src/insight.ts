import { fetchAPI } from './client'

type QueryValue = string | number | boolean | null | undefined

function withQuery(path: string, params: Record<string, QueryValue>): string {
  const q = new URLSearchParams()
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return
    const sv = String(v).trim()
    if (!sv) return
    q.set(k, sv)
  })
  const s = q.toString()
  return s ? `${path}?${s}` : path
}

export const insightApi = {
  quote: <T>(symbol: string, market: string) =>
    fetchAPI<T>(`/quotes/${encodeURIComponent(symbol)}?market=${encodeURIComponent(market)}`),

  klineSummary: <T>(symbol: string, market: string) =>
    fetchAPI<T>(`/klines/${encodeURIComponent(symbol)}/summary?market=${encodeURIComponent(market)}`),

  klines: <T>(symbol: string, params: { market: string; days?: number; interval?: string }) =>
    fetchAPI<T>(
      withQuery(`/klines/${encodeURIComponent(symbol)}`, {
        market: params.market,
        days: params.days,
        interval: params.interval,
      })
    ),

  suggestions: <T>(
    symbol: string,
    params: { market?: string; limit?: number; include_expired?: boolean }
  ) =>
    fetchAPI<T>(
      withQuery(`/suggestions/${encodeURIComponent(symbol)}`, {
        market: params.market,
        limit: params.limit,
        include_expired: params.include_expired,
      })
    ),

  news: <T>(params: Record<string, QueryValue>) => fetchAPI<T>(withQuery('/news', params)),

  history: <T>(params: Record<string, QueryValue>) => fetchAPI<T>(withQuery('/history', params)),

  portfolioSummary: <T>(params?: { include_quotes?: boolean }) =>
    fetchAPI<T>(
      withQuery('/portfolio/summary', {
        include_quotes: params?.include_quotes,
      })
    ),

  addPositionEval: (params: AddPositionEvalParams) =>
    fetchAPI<AddPositionEvalResult>('/insights/add-position-eval', {
      method: 'POST',
      body: JSON.stringify(params),
      timeoutMs: 60000, // AI 评估较慢,放宽超时
    }),

  announcementEval: (params: { symbol: string; market: string; model_id?: number }) =>
    fetchAPI<AnnouncementEvalResult>('/insights/announcement-eval', {
      method: 'POST',
      body: JSON.stringify(params),
      timeoutMs: 40000,
    }),

  uziReport: <T>(symbol: string, market: string) =>
    fetchAPI<T>(`/uzi/report?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`),

  /** 列表页用:一次拿到所有已有 UZI 报告的摘要 */
  uziList: <T>() => fetchAPI<T>('/uzi/list'),

  uziResync: <T>(symbol: string, market: string) =>
    fetchAPI<T>(`/uzi/resync?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`, {
      method: 'POST',
    }),

  /** 后台真跑一次 UZI 调研（lite/medium），立即返回任务 */
  uziAnalyze: <T>(symbol: string, market: string, tier?: string) =>
    fetchAPI<T>(
      `/uzi/analyze?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}${
        tier ? `&tier=${encodeURIComponent(tier)}` : ''
      }`,
      { method: 'POST', timeoutMs: 30000 },
    ),

  /** 轮询调研进度；tail>0 时带日志尾部（失败排查用） */
  uziJob: <T>(symbol: string, market: string, tail = 0) =>
    fetchAPI<T>(
      `/uzi/job?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}&tail=${tail}`,
    ),

  /** 结构化进度快照（7 阶段 + 逐维状态 + 用量） */
  uziJobProgress: (symbol: string, market: string) =>
    fetchAPI<UziJobProgressResponse>(
      `/uzi/job/progress?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`,
    ),

  /** SSE 路径（交给 subscribeSSE 消费，它内部会拼 /api 前缀） */
  uziJobStreamPath: (symbol: string, market: string) =>
    `/uzi/job/stream?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`,

  /** 把缺的维度渲染成一段可粘贴的补数 prompt（交给 WorkBuddy agent 用通达信补数据） */
  uziGapPrompt: <T>(symbol: string, market: string) =>
    fetchAPI<T>(
      `/uzi/gap-prompt?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`,
    ),
}

export interface UziDimension {
  score: number
  weight: number
  label: string
  reasons_pass: string[]
  reasons_fail: string[]
}

/** 维度数据性质: ok=真实采集算出 / stub=UZI 固定占位分 / weak=兜底推断 / none=未采集或不适用 */
export interface UziDimStatus {
  status: 'ok' | 'stub' | 'weak' | 'none'
  note?: string
}

/** 真实口径评分：只用有实测数据的维度重算，明确标出缺什么 */
export interface UziScoreIntegrity {
  real_score?: number | null
  raw_real_score?: number | null
  trusted?: boolean
  real_dims?: number
  total_dims?: number
  real_weight_sum?: number
  total_weight_sum?: number
  real_weight_pct?: number
  status_counts?: Record<string, number>
  real_dim_keys?: string[]
  missing?: { key: string; label: string; status: 'ok' | 'stub' | 'weak' | 'none'; note: string; weight?: number }[]
  note?: string
}

export interface UziReport {
  exists: boolean
  symbol?: string
  market?: string
  tier?: string
  as_of_date?: string
  /** UZI 的 19 维基本面加权分：含 7 个固定占位分与未采集的默认分 */
  fundamental_score?: number
  /** UZI 自己的综合分 = 基本面×0.6 + 评委共识×0.4（one-liner 的「体检结果 x 分」就是它） */
  uzi_overall_score?: number | null
  /** 66 位投资流派评委压出来的共识分（0–100） */
  panel_consensus?: number | null
  /** 本次真正投票的评委人数（其余 skip 未表态） */
  panel_active?: number | null
  consensus_valid?: boolean | null
  verdict_detail?: string
  verdict_label?: string
  /** 只用实测维度重算的分（real_score 不可信时为 null） */
  real_score?: number | null
  trusted?: boolean
  score_integrity?: UziScoreIntegrity
  one_liner?: string
  /** UZI 的字段覆盖率（18 个基础字段），不是 19 维完整度 */
  coverage_pct?: number
  field_coverage_pct?: number
  dimensions?: Record<string, UziDimension>
  dim_status?: Record<string, UziDimStatus>
  html_available?: boolean
}

/** /uzi/list 摘要项：用于列表页「UZI xx」标签 */
export interface UziListItem {
  symbol: string
  market: string
  tier?: string
  as_of_date?: string
  fundamental_score?: number
  real_score?: number | null
  trusted?: boolean
  real_dims?: number
  total_dims?: number
  real_weight_pct?: number
  one_liner?: string
  coverage_pct?: number
  field_coverage_pct?: number
  html_available?: boolean
  /** 报告实际产出时刻（ISO，带时区）。列表标签下方显示用 */
  report_time?: string | null
}

/** /uzi/gap-prompt 返回：给 WorkBuddy agent 执行的补数任务卡 */
export interface UziGapPromptResult {
  ok: boolean
  symbol: string
  market: string
  /** UZI 原始 ticker，如 688363.SH */
  ticker: string
  name: string
  tier?: string | null
  /** 缺多少维（已排除该市场不适用的维） */
  n_missing: number
  /** 实测维数 / 总维数，用于「全部实测」时的提示 */
  real_dims?: number
  total_dims?: number
  /** 按收益分档的缺口数：A 直接改分 / B 喂评委 / C 只改文案 */
  tier_counts: Record<string, number>
  /** 非空表示读不到 UZI 缓存，prompt 只有维度级描述 */
  raw_note?: string
  prompt: string
}

/** UZI 调研的 7 个阶段（顺序即执行顺序，后端 uzi_progress.STAGE_SPECS 直出） */
export type UziStageKey =
  | 'preflight'
  | 'collect_w1'
  | 'collect_w2'
  | 'collect_w3'
  | 'scoring'
  | 'synthesize'
  | 'render'

export interface UziStageRow {
  key: UziStageKey
  label: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  /** "13/17"（评分实测）、"采集上报 22/22（含取空）"、"464.9s" —— 前后两者口径不同，不可混用 */
  detail?: string
}

/**
 * 维度状态。`ok` 行只代表 fetcher 跑完了，quality 才是真实结果，
 * 所以 full/partial/missing 必须分开——`missing` 等于白跑。
 */
export type UziDimState =
  | 'pending'
  | 'full'
  | 'partial'
  | 'missing'
  | 'error'
  | 'timeout'
  | 'skipped'

export interface UziDimItem {
  key: string
  label: string
  /** basic / finance / market / chain / company / macro / safety */
  group: string
  state: UziDimState
  note?: string
}

export interface UziProgressUsage {
  /** 本档位应跑的 fetcher 数（lite 9 / medium 22） */
  fetchers_expected: number
  /** banner 里 UZI 自报的 "fetchers: 20/20 维"（采集上报数，含取空/超时，不代表实测） */
  fetchers_declared?: number | null
  fetchers_total?: number | null
  max_workers?: number | null
  /** baostock 等数据源的 "login success!" 次数，代表真实外呼 */
  source_logins: number
  /** 搜索预算上限（lite 0 / medium 30） */
  ddg_budget: number
  /** UZI 从不打印真实消耗，恒为 null —— UI 必须标注「未上报」 */
  ddg_used: number | null
  collect_sec?: number | null
  log_bytes: number
}

export interface UziProgress {
  schema: number
  tier: string
  /** 解析降级（UZI 改了日志格式等），true 时调用方应回退到 job.phase/done_dims */
  degraded: boolean
  degraded_reason?: string
  stages: UziStageRow[]
  current_stage: UziStageKey | null
  dims: {
    expected: number
    reported: number
    full: number
    partial: number
    missing: number
    error: number
    timeout: number
    pending: number
    skipped: number
    items: UziDimItem[]
  }
  usage: UziProgressUsage
  /** 日志近 60s 仍在增长（服务重启后孤儿进程还在写时为 true） */
  log_live: boolean
  parsed_at: string
}

/** /uzi/job/progress 与 /uzi/job/stream 的共同 payload */
export interface UziJobProgressResponse {
  exists: boolean
  job?: UziJob
}

/** 后台调研任务（/uzi/analyze 与 /uzi/job 返回） */
export interface UziJob {
  job_id: string
  symbol: string
  market: string
  ticker?: string
  tier?: string
  status: 'running' | 'success' | 'failed' | 'interrupted'
  pid?: number
  started_at?: string
  finished_at?: string
  exit_code?: number | null
  error?: string | null
  running?: boolean
  can_restart?: boolean
  done_dims?: number
  phase?: string
  elapsed_sec?: number | null
  result?: {
    tier?: string
    as_of_date?: string
    fundamental_score?: number
    real_score?: number | null
    real_dims?: number
    total_dims?: number
    trusted?: boolean
    coverage_pct?: number
  } | null
  /** 结构化进度（/uzi/job/progress 与 SSE 才有；null 表示解析降级） */
  progress?: UziProgress | null
  log_tail?: string[]
}

export interface AnnouncementToneItem {
  title: string
  time: string
  tone: string // 利好 / 利空 / 中性
  summary: string
}

export interface AnnouncementEvalResult {
  symbol: string
  market: string
  items: AnnouncementToneItem[]
}

export interface AddPositionEvalParams {
  symbol: string
  market: string
  current_quantity: number
  current_cost: number
  add_quantity: number
  add_price: number
  model_id?: number
}

export interface AddPositionEvalResult {
  symbol: string
  market: string
  action: string // 加仓 / 建仓
  new_cost: number
  dilute_abs: number
  dilute_pct: number
  total_quantity: number
  total_invested: number
  verdict: string // 适合 / 谨慎 / 不适合 / 未知
  content: string // markdown 结论
}
