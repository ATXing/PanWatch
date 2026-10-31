import { useTranslation } from 'react-i18next'

import { thsUrl } from '@/lib/stock-links'

type ThsLinkProps = {
  symbol: string
  market?: string | null
  name?: string
  className?: string
}

/**
 * 股票名后的「同花顺」入口：小字 chip，新窗口打开该股的同花顺个股页。
 *
 * 三个不能省的属性：
 * - draggable={false}：`<a>` 默认是 HTML5 拖动源，会抢掉所在 `<tr>` / 卡片的拖拽排序
 * - stopPropagation：关注卡片整卡有 onClick（打开 Agent 弹窗），不拦会同时弹窗
 * - shrink-0：名字按钮带 truncate，不加会被压扁
 *
 * 拼不出合法地址（美股权证、港股人民币柜台码等）时整个入口不渲染，不给死链。
 */
export function ThsLink({ symbol, market, name, className = '' }: ThsLinkProps) {
  const { t } = useTranslation()
  const href = thsUrl(symbol, market)
  if (!href) return null
  const hint = t('links.tonghuashunHint', { name: name || symbol })
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      draggable={false}
      title={hint}
      aria-label={hint}
      onClick={(event) => event.stopPropagation()}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border border-border/50 px-1 py-px text-[10px] leading-[14px] text-muted-foreground/80 transition-colors hover:border-primary/50 hover:text-primary ${className}`}
    >
      {t('links.tonghuashun')}
    </a>
  )
}
