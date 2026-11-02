import type { UziDimItem, UziDimState, UziProgress, UziStageRow } from '@panwatch/api'

/**
 * UZI 调研过程面板：阶段进度 + 逐维打勾 + 用量脚注。
 *
 * 与 TradingAgents 的 DeepAnalysisModal 视觉对齐（文本字符 ✓/⟳/⏸ + 三色），
 * 但刻意**不复用**它的 StageRow —— 那边硬绑了 tradingagents 的 stage 枚举与 i18n 前缀。
 *
 * 三个刻意的设计：
 * 1. lite 档也渲染全部 22 个格子，本档不跑的 13 个画斜线灰格。看到「只覆盖 9 个」
 *    比隐藏 13 个更诚实，也避免切档位时网格变形。
 * 2. `missing` 与 `timeout` 都要显眼 —— 前者是「跑了但没拿到」，后者是「压根没跑完」，
 *    两者都不该显示成绿的（`ok` 行第三列 quality 才是真实结果）。
 * 3. 用量里**不出现 token、不出现金额**：UZI 是纯规则引擎，全程无 LLM 调用，
 *    token 恒为 0；搜索预算只报上限（UZI 从不打印真实消耗），不做假数。
 */

const GROUP_ORDER = ['basic', 'finance', 'market', 'chain', 'company', 'macro', 'safety'] as const

const GROUP_LABELS: Record<string, string> = {
  basic: '基础与共享',
  finance: '财务与估值',
  market: '行情与资金',
  chain: '产业链与行业',
  company: '公司治理与事件',
  macro: '宏观与政策',
  safety: '情绪与风险',
}

const STAGE_ICON: Record<UziStageRow['status'], string> = {
  done: '✓',
  running: '⟳',
  pending: '⏸',
  skipped: '—',
  failed: '✕',
}

const STAGE_CLS: Record<UziStageRow['status'], string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  running: 'text-primary',
  pending: 'text-muted-foreground/60',
  skipped: 'text-muted-foreground/40',
  failed: 'text-rose-600 dark:text-rose-400',
}

const DOT_CLS: Record<UziDimState, string> = {
  full: 'bg-emerald-500',
  partial: 'bg-amber-500',
  missing: 'bg-rose-400/50',
  error: 'bg-rose-500',
  timeout: 'bg-rose-500',
  pending: 'bg-muted-foreground/20 ring-1 ring-inset ring-muted-foreground/30',
  skipped: 'bg-muted-foreground/10',
}

const STATE_TEXT: Record<UziDimState, string> = {
  full: '完整',
  partial: '部分',
  missing: '空',
  error: '失败',
  timeout: '超时',
  pending: '未开始',
  skipped: '本档不跑',
}

function fmtElapsed(sec?: number | null): string {
  if (typeof sec !== 'number' || sec < 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

function StageLine({ stage }: { stage: UziStageRow }) {
  return (
    <div className={`flex items-center gap-2 text-[12px] ${STAGE_CLS[stage.status]}`}>
      <span
        className={`w-4 shrink-0 ${stage.status === 'running' ? 'inline-block animate-spin' : ''}`}
      >
        {STAGE_ICON[stage.status]}
      </span>
      <span className="truncate">{stage.label}</span>
      {stage.detail && (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {stage.detail}
        </span>
      )}
    </div>
  )
}

function DimCell({ item }: { item: UziDimItem }) {
  const tip = `${item.label} · ${STATE_TEXT[item.state]}${item.note ? ` · ${item.note}` : ''}`
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] ${
        item.state === 'skipped' ? 'text-muted-foreground/40' : 'text-foreground/75'
      }`}
      title={tip}
    >
      <i
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLS[item.state]}`}
        aria-hidden
      />
      {item.label}
    </span>
  )
}

function DimGrid({ items }: { items: UziDimItem[] }) {
  const byGroup = new Map<string, UziDimItem[]>()
  for (const it of items) {
    const arr = byGroup.get(it.group) ?? []
    arr.push(it)
    byGroup.set(it.group, arr)
  }
  return (
    <div className="space-y-1">
      {GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => (
        <div key={g} className="flex items-start gap-2">
          <span className="w-[72px] shrink-0 pt-[1px] text-[10px] text-muted-foreground/70">
            {GROUP_LABELS[g] ?? g}
          </span>
          <div className="flex flex-wrap gap-x-2.5 gap-y-1">
            {(byGroup.get(g) ?? []).map((it) => (
              <DimCell key={it.key} item={it} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function UsageFoot({ progress }: { progress: UziProgress }) {
  const u = progress.usage
  const parts: string[] = []
  parts.push(`采集上报 ${progress.dims.reported}/${u.fetchers_expected}（含取空）`)
  const bad = progress.dims.error + progress.dims.timeout
  if (bad > 0) parts.push(`失败/超时 ${bad}`)
  if (u.source_logins > 0) parts.push(`数据源握手 ${u.source_logins} 次`)
  parts.push(`搜索预算 ${u.ddg_budget}（上限，消耗未上报）`)
  if (u.max_workers) parts.push(`并发 ${u.max_workers}`)
  return <div className="text-[10px] leading-relaxed text-muted-foreground">{parts.join(' · ')}</div>
}

export interface UziProgressPanelProps {
  /** 结构化进度；null/undefined 时回退到 phase + done_dims 的单行显示 */
  progress?: UziProgress | null
  /** 后端算好的已用秒数 */
  elapsedSec?: number | null
  tier?: string
  /** 回退用的旧字段（progress 缺失或 degraded 时） */
  fallbackPhase?: string
  fallbackDoneDims?: number
  /** 终态折叠：只显示一行摘要 + 展开按钮 */
  collapsed?: boolean
  onToggle?: () => void
}

export function UziProgressPanel({
  progress,
  elapsedSec,
  tier,
  fallbackPhase,
  fallbackDoneDims,
  collapsed = false,
  onToggle,
}: UziProgressPanelProps) {
  const degraded = !progress || progress.degraded

  // 降级：保持原来那一行文字的观感，不显示半截结构
  if (degraded) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-foreground/85">
        <span className="font-medium">UZI 调研中</span>
        <span className="text-muted-foreground">已 {fmtElapsed(elapsedSec)}</span>
        {fallbackPhase && <span className="text-muted-foreground">· {fallbackPhase}</span>}
        {typeof fallbackDoneDims === 'number' && fallbackDoneDims > 0 && (
          <span className="text-muted-foreground">· 已完成 {fallbackDoneDims} 个维度</span>
        )}
        <span className="text-muted-foreground">
          · {tier ?? 'medium'}档 · 约 {(tier ?? 'medium') === 'lite' ? '3–6' : '6–15'} 分钟
        </span>
      </div>
    )
  }

  const d = progress.dims
  const curLabel =
    progress.stages.find((s) => s.key === progress.current_stage)?.label ?? '准备中'
  const summary = `已 ${fmtElapsed(elapsedSec)} · ${curLabel} · 采集上报 ${d.reported}/${d.expected}（含取空）`

  if (collapsed) {
    return (
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-foreground/80">
        <span className="text-muted-foreground">{summary}</span>
        <span className="text-muted-foreground">
          · 完整 {d.full} / 部分 {d.partial} / 空 {d.missing}
          {d.error + d.timeout > 0 ? ` / 失败 ${d.error + d.timeout}` : ''}
        </span>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="text-[11px] text-primary underline-offset-2 hover:underline"
          >
            查看过程
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* 摘要行 */}
      <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-foreground/85">
        <span className="font-medium">UZI 调研中</span>
        <span className="text-muted-foreground">已 {fmtElapsed(elapsedSec)}</span>
        <span className="text-muted-foreground">
          · 采集上报 {d.reported}/{d.expected}（含取空）
        </span>
        <span className="text-muted-foreground">
          · {tier ?? progress.tier}档 · 约 {(tier ?? progress.tier) === 'lite' ? '3–6' : '6–15'} 分钟
        </span>
        {progress.log_live && (
          <span className="text-amber-600 dark:text-amber-400">· 日志仍在更新</span>
        )}
      </div>

      {/* 阶段列表 */}
      <div className="space-y-0.5">
        {progress.stages.map((s) => (
          <StageLine key={s.key} stage={s} />
        ))}
      </div>

      {/* 维度网格 */}
      <DimGrid items={d.items} />

      {/* 用量脚注 */}
      <UsageFoot progress={progress} />
    </div>
  )
}

export default UziProgressPanel
