import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StockNoteButton } from '@panwatch/biz-ui/components/stock-note'

const { updateNoteMock } = vi.hoisted(() => ({ updateNoteMock: vi.fn() }))

vi.mock('@panwatch/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@panwatch/api')>()
  return {
    ...actual,
    stocksApi: { ...actual.stocksApi, updateNote: updateNoteMock },
  }
})

afterEach(cleanup)
beforeEach(() => updateNoteMock.mockReset())

const trigger = () => screen.getByRole('button', { name: /备注/ })

describe('stock note button', () => {
  it('shows the whole note on hover instead of truncating it to three lines', () => {
    // 500 字中文 ≈ 14 行；若沿用摘要的默认 3 行上限，这里会被截成省略号
    render(<StockNoteButton stockId={7} note={'甲'.repeat(500)} />)
    const tip = trigger().getAttribute('title') || ''
    expect(tip.split('\n').length).toBeGreaterThan(3)
    expect(tip).not.toContain('…')
  })

  it('highlights the icon when a note exists and dims it otherwise', () => {
    const { rerender } = render(<StockNoteButton stockId={7} note="有备注" />)
    expect(trigger().getAttribute('aria-label')).toBe('编辑备注')
    expect(trigger().className).toContain('text-amber-600')

    rerender(<StockNoteButton stockId={7} note="" />)
    expect(trigger().getAttribute('aria-label')).toBe('添加备注')
    expect(trigger().className).toContain('text-muted-foreground/35')
  })

  it('prefills the editor with the saved note and counts characters', async () => {
    render(<StockNoteButton stockId={7} note="原文本" />)
    fireEvent.click(trigger())

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(box.value).toBe('原文本')
    expect(box.getAttribute('maxlength')).toBe('500')
    expect(dialog.textContent).toContain('3/500')
  })

  it('sends the full text (not a delta) and reports the saved value back', async () => {
    updateNoteMock.mockResolvedValue({ id: 7, note: '原文本补一句' })
    const onSaved = vi.fn()
    render(<StockNoteButton stockId={7} note="原文本" onSaved={onSaved} />)

    fireEvent.click(trigger())
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '原文本补一句' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(updateNoteMock).toHaveBeenCalledWith(7, '原文本补一句'))
    expect(onSaved).toHaveBeenCalledWith(7, '原文本补一句')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('only empties the box on clear — the request happens on save', async () => {
    updateNoteMock.mockResolvedValue({ id: 7, note: '' })
    render(<StockNoteButton stockId={7} note="要删的内容" />)

    fireEvent.click(trigger())
    fireEvent.click(await screen.findByRole('button', { name: '清空' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    // 关键：清空不是「直接删库」，误触还能靠取消救回来
    expect(updateNoteMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateNoteMock).toHaveBeenCalledWith(7, ''))
  })

  it('discards the draft on cancel without touching the server', async () => {
    render(<StockNoteButton stockId={7} note="原文本" />)

    fireEvent.click(trigger())
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '改了但不想要' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(updateNoteMock).not.toHaveBeenCalled()

    fireEvent.click(trigger())
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('原文本')
  })

  it('does not fire the enclosing card click (watchlist card opens the agent dialog)', async () => {
    const cardClick = vi.fn()
    const { container } = render(
      <div onClick={cardClick}>
        <StockNoteButton stockId={7} note="备注" />
      </div>,
    )
    fireEvent.click(container.querySelector('button') as HTMLButtonElement)

    await screen.findByRole('dialog')
    expect(cardClick).not.toHaveBeenCalled()
  })

  it('does not fire the enclosing card click when clicking inside the dialog', async () => {
    // Radix 的 Portal 只把 DOM 挪到 body，React 合成事件仍沿【组件树】冒泡，
    // 所以弹窗里的每次点击都会经过外层卡片的 onClick（它就是「配置监控 Agent」的入口）。
    updateNoteMock.mockResolvedValue({ id: 7, note: '新内容' })
    const cardClick = vi.fn()
    render(
      <div onClick={cardClick}>
        <StockNoteButton stockId={7} note="备注" />
      </div>,
    )

    fireEvent.click(trigger())
    const box = await screen.findByRole('textbox')
    fireEvent.click(box)
    fireEvent.change(box, { target: { value: '新内容' } })
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(cardClick).not.toHaveBeenCalled()

    // 保存会让弹窗卸载，事件仍要拦得住
    fireEvent.change(box, { target: { value: '新内容' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateNoteMock).toHaveBeenCalledWith(7, '新内容'))
    expect(cardClick).not.toHaveBeenCalled()
  })
})
