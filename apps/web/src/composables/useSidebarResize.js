import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const STORAGE_KEY = 'promptx:v2:sidebar-width'
const MIN_WIDTH = 180
const MAX_WIDTH = 520
const WORKBENCH_MIN_WIDTH = 360
const DIVIDER_WIDTH = 8

export function useSidebarResize(shell) {
  const preferredWidth = ref(null)
  const containerWidth = ref(0)
  const viewportWidth = ref(0)
  const dragging = ref(false)
  let observer
  let capture = null
  let startX = 0
  let startWidth = 0
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY))
    if (Number.isFinite(stored) && stored >= MIN_WIDTH) preferredWidth.value = Math.min(MAX_WIDTH, stored)
  } catch { /* 存储不可用时仍允许拖动。 */ }

  const maxWidth = computed(() => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, containerWidth.value - WORKBENCH_MIN_WIDTH - DIVIDER_WIDTH)))
  const defaultWidth = computed(() => viewportWidth.value <= 900 ? 200 : 240)
  const width = computed(() => Math.max(MIN_WIDTH, Math.min(maxWidth.value, preferredWidth.value ?? defaultWidth.value)))

  function persist() {
    try {
      if (preferredWidth.value === null) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, String(preferredWidth.value))
    } catch { /* 宽度保留在当前页面。 */ }
  }
  function stop() {
    if (!dragging.value) return
    dragging.value = false
    const previous = capture
    capture = null
    if (previous?.element.hasPointerCapture(previous.id)) previous.element.releasePointerCapture(previous.id)
    persist()
  }
  function start(event) {
    if (event.button !== 0 || viewportWidth.value <= 720) return
    event.preventDefault()
    startX = event.clientX
    startWidth = width.value
    capture = { element: event.currentTarget, id: event.pointerId }
    capture.element.setPointerCapture(capture.id)
    dragging.value = true
  }
  function resize(event) {
    if (!dragging.value || event.pointerId !== capture?.id) return
    preferredWidth.value = Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth.value, startWidth + event.clientX - startX)))
  }
  function resizeKey(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    preferredWidth.value = event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth.value
      : Math.max(MIN_WIDTH, Math.min(maxWidth.value, width.value + (event.key === 'ArrowRight' ? 10 : -10)))
    persist()
  }
  function reset() { preferredWidth.value = null; persist() }

  onMounted(() => {
    const measure = () => {
      containerWidth.value = shell.value.clientWidth
      viewportWidth.value = window.innerWidth
      if (viewportWidth.value <= 720) stop()
    }
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(shell.value)
  })
  onBeforeUnmount(() => { observer?.disconnect(); stop() })
  return { width, maxWidth, minWidth: MIN_WIDTH, dragging, start, resize, stop, resizeKey, reset }
}
