import { useEffect, useMemo, useState } from 'react'
import { StickyNote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { stocksApi } from '@panwatch/api'
import { wrapForTitle } from '@panwatch/biz-ui/lib/title-wrap'

/** 与后端 StockUpdate.note 的 Field(max_length=500) 保持一致，前端超了也发不出去 */
export const STOCK_NOTE_MAX_LENGTH = 500

/**
 * 备注全文折行用的行数上限。默认的 3 行是给「摘要」的，会把长备注截成省略号；
 * 500 字中文约 36 字/行 ≈ 14 行、英文约 60 字符/行 ≈ 9 行，20 行足够放下全文。
 */
const TITLE_MAX_LINES = 20

export interface StockNoteButtonProps {
  stockId: number
  /** 当前备注。空串 / undefined / null 都视为「没有备注」 */
  note?: string | null
  /** 保存成功回调：父级用它局部回写 stocks，避免整页刷新 */
  onSaved?: (stockId: number, note: string) => void
  className?: string
}

/**
 * 股票备注入口：名字后面一枚小图标，悬停看全文，点击开弹窗编辑。
 *
 * 交互口径：
 * - 保存 = PUT 落库；
 * - 清空 = 只清空输入框草稿，必须再点保存才生效（防误触把已有备注一键删掉）；
 * - 取消 / Esc / 点遮罩 = 丢弃草稿，一个请求都不发。
 */
export function StockNoteButton({ stockId, note, onSaved, className = '' }: StockNoteButtonProps) {
  const { t, i18n } = useTranslation('bizUi')
  const { toast } = useToast()
  const tr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(
      `stockNote.${key}`,
      options,
    )
  const english = (i18n.resolvedLanguage || i18n.language).toLowerCase().startsWith('en')

  // committed = 已落库的值（本地镜像）：父级没传 onSaved 时也能自洽地更新图标状态
  const [committed, setCommitted] = useState(() => note ?? '')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // 父级刷新（如重新拉取 /stocks）后跟随外部值
  useEffect(() => {
    setCommitted(note ?? '')
  }, [note])

  const hasNote = committed.trim().length > 0
  const hint = hasNote ? tr('edit') : tr('add')
  const hoverTip = useMemo(
    () => (hasNote ? wrapForTitle(committed, english ? 60 : 36, TITLE_MAX_LINES).join('\n') : hint),
    [committed, english, hasNote, hint],
  )

  const openEditor = (event: React.MouseEvent<HTMLButtonElement>) => {
    // 关注股是整卡可点（会弹「配置监控 Agent」），持仓行/卡片是 draggable，两个都得挡住
    event.stopPropagation()
    event.preventDefault()
    setDraft(committed)
    setOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await stocksApi.updateNote(stockId, draft)
      const saved = updated?.note ?? draft
      setCommitted(saved)
      onSaved?.(stockId, saved)
      setOpen(false)
      toast(tr('saved'), 'success')
    } catch (error) {
      // 失败时保持弹窗打开，草稿不丢，用户可以直接重试
      toast(error instanceof Error ? error.message : tr('saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        draggable={false}
        aria-label={hint}
        title={hoverTip}
        onClick={openEditor}
        onMouseDown={event => event.stopPropagation()}
        onDragStart={event => event.preventDefault()}
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded transition-colors ${
          hasNote
            ? 'text-amber-600 hover:text-amber-500 dark:text-amber-400'
            : 'text-muted-foreground/35 hover:text-muted-foreground'
        } ${className}`}
      >
        <StickyNote className="h-3 w-3" aria-hidden />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/*
         * 必须挡住冒泡：Radix 的 Portal 只把 DOM 挪到 body，React 合成事件仍沿【组件树】冒泡，
         * 而这个弹窗写在卡片内部 —— 不拦的话点输入框会一路冒到关注股卡片的 onClick，
         * 把「配置监控 Agent」弹出来（kline-summary-dialog / suggestion-badge 同样做法）。
         */}
        <DialogContent className="max-w-md" onClick={event => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{tr('title')}</DialogTitle>
            <DialogDescription>{tr('description')}</DialogDescription>
          </DialogHeader>
          <textarea
            value={draft}
            maxLength={STOCK_NOTE_MAX_LENGTH}
            rows={5}
            aria-label={tr('title')}
            placeholder={tr('placeholder')}
            onChange={event => setDraft(event.target.value)}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none transition-colors focus:border-primary/60 scrollbar"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground/70">{tr('clearHint')}</span>
            <span className="text-[11px] text-muted-foreground">
              {tr('counter', { count: draft.length, max: STOCK_NOTE_MAX_LENGTH })}
            </span>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={saving || !draft} onClick={() => setDraft('')}>
              {tr('clear')}
            </Button>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
              {tr('cancel')}
            </Button>
            <Button size="sm" disabled={saving} onClick={handleSave}>
              {saving ? tr('saving') : tr('save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
