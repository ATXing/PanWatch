import { fetchAPI } from './client'

export type AssetType = 'stock' | 'etf'

export interface StockAgentInfo {
  agent_name: string
  schedule: string
  ai_model_id: number | null
  notify_channel_ids: number[]
}

export interface StockItem {
  id: number
  symbol: string
  name: string
  market: string
  asset_type?: AssetType
  sort_order?: number
  /** 用户自记备注（按股票存一条，持仓页与关注列表共用） */
  note?: string
  agents?: StockAgentInfo[]
}

export interface StockCreatePayload {
  symbol: string
  name: string
  market: string
  asset_type?: AssetType
}

export interface StockAgentUpdatePayload {
  agents: Array<{
    agent_name: string
    schedule?: string
    ai_model_id?: number | null
    notify_channel_ids?: number[]
  }>
}

export interface TriggerStockAgentOptions {
  bypass_throttle?: boolean
  bypass_market_hours?: boolean
  allow_unbound?: boolean
  wait?: boolean
  force_refresh?: boolean
  symbol?: string
  market?: string
  name?: string
}

export interface TriggerStockAgentResponse {
  result?: Record<string, any>
  code?: number
  success?: boolean
  message: string
  queued?: boolean
}

function withQuery(path: string, params: TriggerStockAgentOptions): string {
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

export const stocksApi = {
  list: () => fetchAPI<StockItem[]>('/stocks'),
  create: (payload: StockCreatePayload) =>
    fetchAPI<StockItem>('/stocks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  remove: (id: number) => fetchAPI<{ ok: boolean }>(`/stocks/${id}`, { method: 'DELETE' }),
  /** 只写备注。注意：清空必须传空串，传 null 会被后端 exclude_none 丢弃（看起来成功但没清掉） */
  updateNote: (id: number, note: string) =>
    fetchAPI<StockItem>(`/stocks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }),
  updateAgents: (id: number, payload: StockAgentUpdatePayload) =>
    fetchAPI<StockItem>(`/stocks/${id}/agents`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  triggerAgent: (id: number, agentName: string, options: TriggerStockAgentOptions = {}) =>
    fetchAPI<TriggerStockAgentResponse>(
      withQuery(`/stocks/${id}/agents/${encodeURIComponent(agentName)}/trigger`, options),
      { method: 'POST', timeoutMs: 120_000 }
    ),
}
