/**
 * 格式化日期时间，去掉毫秒
 * @param {string|Date} val - 日期字符串或 Date 对象
 * @param {boolean} showSeconds - 是否显示秒，默认 true
 * @returns {string} 格式化后的日期字符串
 */
export function formatDate(val, showSeconds = true) {
  if (!val) return ''
  // 如果已经是 YYYY-MM-DD 格式（没有时间部分），直接返回
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(val))) return val
  try {
    const d = new Date(val)
    if (isNaN(d.getTime())) return String(val) // 无法解析，原样返回
    const Y = d.getFullYear()
    const M = String(d.getMonth() + 1).padStart(2, '0')
    const D = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return showSeconds ? `${Y}-${M}-${D} ${h}:${m}:${s}` : `${Y}-${M}-${D} ${h}:${m}`
  } catch {
    return String(val)
  }
}
