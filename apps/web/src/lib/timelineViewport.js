// 只容忍浏览器滚动计算产生的少量小数误差；接近底部不等于已经到底。
export const TIMELINE_BOTTOM_THRESHOLD = 2

export function isTimelineAtBottom(element, threshold = TIMELINE_BOTTOM_THRESHOLD) {
  if (!element) return true
  return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold
}
