import type { MouseEventHandler } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@panwatch/base-ui'
import { BadgeChip, type BadgeChipSize } from '@panwatch/biz-ui/components/badge-chip'
import { suggestionPresentation, extractConfidencePercent, type SuggestionStateInput } from '@panwatch/biz-ui/components/suggestion-action'

interface AiSuggestionBadgeProps extends SuggestionStateInput {
  action?: string
  actionLabel?: string
  isAI?: boolean
  isExpired?: boolean
  size?: BadgeChipSize
  className?: string
  title?: string
  onClick?: MouseEventHandler<HTMLButtonElement>
}

export function AiSuggestionBadge({
  action,
  actionLabel,
  isAI = false,
  isExpired = false,
  size = 'md',
  className,
  title,
  onClick,
  status, review_required, attention_required, rating_raw, meta, action_label,
  outlook, confidence, execution_status, execution_constraints,
}: AiSuggestionBadgeProps) {
  const { t } = useTranslation('bizUi')
  const view = suggestionPresentation({ action, action_label: action_label || actionLabel, status, review_required, attention_required, rating_raw, meta,
    outlook, confidence, execution_status, execution_constraints })
  const tr = t as unknown as (key: string, options?: Record<string, unknown>) => string
  // 置信度只在「带 agent 来源的 AI 建议」上追加，且只读建议池 meta.plan.confidence（0~1）。
  // 技术面兜底徽章（technical_fallback）与纯 K 线徽章没有这个字段，自然不显示。
  const confidencePct = isAI ? extractConfidencePercent(meta) : null
  const label = tr(view.labelKey)
    + (view.stateLabelKey ? ` · ${tr(view.stateLabelKey)}` : '')
    + (confidencePct != null ? `·${tr('suggestionBadge.confidence', { value: confidencePct })}` : '')
  const colorClass = view.colorClass
  return (
    <BadgeChip
      label={label}
      aiTag={isAI}
      size={size}
      title={title}
      onClick={onClick}
      className={cn(colorClass, isExpired && 'opacity-50', className)}
    />
  )
}
