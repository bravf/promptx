export const TIMELINE_BOTTOM_THRESHOLD = 64

export function isTimelineAtBottom(element, threshold = TIMELINE_BOTTOM_THRESHOLD) {
  if (!element) return true
  return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold
}
