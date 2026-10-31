/**
 * 原生 title 不会自动折行：长文本塞进去，提示框会横向拖出屏幕。
 * 按语言宽度手动切行（中文 36 字/行、英文 60 字符/行），最多 maxLines 行，超出用省略号。
 *
 * 两个细节：
 * 1. 中文切点若紧跟着标点，把标点收进本行，否则「，」会孤零零落在行首；
 * 2. 英文优先在空格处断开，且不把英文单词/数字劈成两半（「BOLL」被切成「BOL / L」）。
 *
 * 注意 maxLines：给「摘要」用默认 3 行即可；给「全文」用必须放大（500 字中文约 14 行），
 * 否则会被省略号截断，与「悬停看全文」的承诺矛盾。
 */
export function wrapForTitle(text: string, perLine: number, maxLines = 3): string[] {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim()
  if (!flat) return []
  const cjk = /[\u4e00-\u9fa5]/.test(flat)
  const leadingPunct = '，。；：、！？）】”’'
  const lines: string[] = []
  let start = 0
  while (start < flat.length && lines.length < maxLines) {
    let end = Math.min(start + perLine, flat.length)
    if (cjk) {
      while (end < flat.length && leadingPunct.includes(flat[end])) end += 1
    } else if (end < flat.length) {
      const space = flat.lastIndexOf(' ', end)
      if (space > start + perLine * 0.6) end = space
    }
    // 别把英文单词/数字劈成两半（「BOLL」被切成「BOL / L」、「(1.8x)」被切成两截）
    while (end > start + 1 && end < flat.length &&
      /[A-Za-z0-9.%]/.test(flat[end - 1]) && /[A-Za-z0-9.%]/.test(flat[end])) end -= 1
    lines.push(flat.slice(start, end).trim())
    start = end
  }
  if (start < flat.length) {
    const last = lines[maxLines - 1]
    lines[maxLines - 1] = last.slice(0, Math.max(0, last.length - 1)) + '…'
  }
  return lines
}
