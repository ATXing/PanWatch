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

export interface UziReport {
  exists: boolean
  symbol?: string
  market?: string
  tier?: string
  as_of_date?: string
  fundamental_score?: number
  one_liner?: string
  coverage_pct?: number
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
  one_liner?: string
  coverage_pct?: number
  html_available?: boolean
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
    coverage_pct?: number
  } | null
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
