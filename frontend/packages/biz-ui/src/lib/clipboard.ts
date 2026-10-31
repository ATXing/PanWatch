/** 复制文本到剪贴板。
 *
 * 优先 `navigator.clipboard`（需要 https 或 localhost）；本地用 http://127.0.0.1
 * 或旧浏览器时它会缺失/拒绝，退回 textarea + execCommand。
 * 返回是否成功，调用方负责提示。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 落到 legacy 分支
    }
  }

  if (typeof document === 'undefined') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return !!document.execCommand?.('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
