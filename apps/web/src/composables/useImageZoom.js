import { ref } from 'vue'

export function useImageZoom(previewElement, previewLoading, previewError) {
  const zoom = ref(1)
  const offset = ref({ x: 0, y: 0 })
  const pointers = new Map()
  let gesture = null
  
  function resetTransform() {
    zoom.value = 1
    offset.value = { x: 0, y: 0 }
    pointers.clear()
    gesture = null
  }
  
  function gesturePosition() {
    const points = [...pointers.values()]
    const first = points[0]
    const second = points[1] || first
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: points.length > 1 ? Math.hypot(second.x - first.x, second.y - first.y) : 0,
    }
  }
  
  function transformAt(scale, from, to = from) {
    const bounds = previewElement.value.getBoundingClientRect()
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    const nextZoom = Math.min(8, Math.max(1, scale))
    const ratio = nextZoom / zoom.value
    offset.value = nextZoom === 1 ? { x: 0, y: 0 } : {
      x: to.x - center.x - (from.x - center.x - offset.value.x) * ratio,
      y: to.y - center.y - (from.y - center.y - offset.value.y) * ratio,
    }
    zoom.value = nextZoom
  }
  
  function handleWheel(event) {
    if (previewLoading.value || previewError.value) return
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1)
    transformAt(zoom.value * Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.005), { x: event.clientX, y: event.clientY })
  }
  
  function startPointer(event) {
    if (event.button !== 0 || previewLoading.value || previewError.value) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    gesture = gesturePosition()
  }
  
  function movePointer(event) {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const next = gesturePosition()
    transformAt(gesture.distance && next.distance ? zoom.value * next.distance / gesture.distance : zoom.value, gesture, next)
    gesture = next
  }
  
  function endPointer(event) {
    pointers.delete(event.pointerId)
    gesture = pointers.size ? gesturePosition() : null
  }
  
  return { zoom, offset, resetTransform, handleWheel, startPointer, movePointer, endPointer }
}
