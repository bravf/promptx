// iPhone 返回手势后可能不生成合成 click；轻点在 touchend 完成。
// 保留原生 click 供鼠标、键盘和辅助技术使用。
const handlers = new WeakMap()

export const vTouchTap = {
  mounted(element, binding) {
    let start = null
    let activate = binding.value
    const reset = () => { start = null }
    const onStart = (event) => {
      reset()
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      // 不干预浏览器两侧的原生导航手势。
      if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return
      const scroller = element.closest('[data-session-scroll]')
      start = { x: touch.clientX, y: touch.clientY, time: performance.now(), scroller, scrollTop: scroller?.scrollTop }
    }
    const onMove = (event) => {
      if (!start || event.touches.length !== 1) return reset()
      const touch = event.touches[0]
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) reset()
    }
    const onEnd = (event) => {
      const tap = start
      reset()
      const touch = event.changedTouches[0]
      if (!tap || !touch || event.touches.length || !event.cancelable) return
      if (performance.now() - tap.time > 700 || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10) return
      if (tap.scroller && tap.scroller.scrollTop !== tap.scrollTop) return
      event.preventDefault()
      activate?.()
    }
    element.addEventListener('touchstart', onStart, { passive: true })
    element.addEventListener('touchmove', onMove, { passive: true })
    element.addEventListener('touchend', onEnd, { passive: false })
    element.addEventListener('touchcancel', reset, { passive: true })
    handlers.set(element, { update: (value) => { activate = value }, cleanup: () => {
      element.removeEventListener('touchstart', onStart)
      element.removeEventListener('touchmove', onMove)
      element.removeEventListener('touchend', onEnd)
      element.removeEventListener('touchcancel', reset)
    } })
  },
  updated(element, binding) { handlers.get(element)?.update(binding.value) },
  beforeUnmount(element) { handlers.get(element)?.cleanup(); handlers.delete(element) },
}
