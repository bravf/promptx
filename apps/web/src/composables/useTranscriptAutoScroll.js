import { nextTick } from 'vue'

const TASK_SWITCH_FORCE_FOLLOW_MS = 1200
const TASK_SWITCH_FORCE_FOLLOW_TICK_DELAYS = [0, 80, 220, 500, 900]

export function useTranscriptAutoScroll(options = {}) {
  const {
    transcriptRef,
    hasNewerMessages,
    threshold = 48,
  } = options

  let pendingScrollJobId = 0
  let pendingScrollFrameIds = []
  let userInteracting = false
  let detachedHasNewMessages = false
  let interactionReleaseJobId = 0
  let followingBottom = true
  let forceFollowUntil = 0
  let forceFollowTickTimerIds = []
  let forceFollowEndTimerId = 0
  let forceFollowResizeObserver = null

  function getTimerApi() {
    const timerHost = typeof window !== 'undefined' ? window : globalThis
    if (typeof timerHost?.setTimeout !== 'function' || typeof timerHost?.clearTimeout !== 'function') {
      return null
    }

    return {
      setTimeout: timerHost.setTimeout.bind(timerHost),
      clearTimeout: timerHost.clearTimeout.bind(timerHost),
    }
  }

  function clearPendingScrollFrames() {
    if (typeof window === 'undefined' || !pendingScrollFrameIds.length) {
      pendingScrollFrameIds = []
      return
    }

    pendingScrollFrameIds.forEach((frameId) => {
      window.cancelAnimationFrame(frameId)
    })
    pendingScrollFrameIds = []
  }

  function cancelScheduledScrollToBottom() {
    pendingScrollJobId += 1
    clearPendingScrollFrames()
  }

  function clearForceFollowTimers() {
    const timerApi = getTimerApi()
    if (!timerApi) {
      forceFollowTickTimerIds = []
      forceFollowEndTimerId = 0
      return
    }

    forceFollowTickTimerIds.forEach((timerId) => {
      timerApi.clearTimeout(timerId)
    })
    forceFollowTickTimerIds = []

    if (forceFollowEndTimerId) {
      timerApi.clearTimeout(forceFollowEndTimerId)
      forceFollowEndTimerId = 0
    }
  }

  function stopForceFollowObserver() {
    forceFollowResizeObserver?.disconnect?.()
    forceFollowResizeObserver = null
  }

  function isForceFollowing() {
    return forceFollowUntil > Date.now()
  }

  function setHasNewerMessages(nextValue) {
    detachedHasNewMessages = Boolean(nextValue)
    if (hasNewerMessages?.value !== undefined) {
      hasNewerMessages.value = detachedHasNewMessages
    }
  }

  function resetAutoStickToBottom() {
    userInteracting = false
    interactionReleaseJobId += 1
    followingBottom = true
    setHasNewerMessages(false)
  }

  function isTranscriptNearBottom(element = transcriptRef?.value) {
    if (!element) {
      return true
    }

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    return distanceToBottom <= threshold
  }

  function shouldAutoFollow() {
    return isForceFollowing() || (followingBottom && !userInteracting)
  }

  function clearDetachedMessagesIfNeeded() {
    if (followingBottom && !userInteracting) {
      setHasNewerMessages(false)
    }
  }

  function handleTranscriptScroll() {
    followingBottom = isTranscriptNearBottom()
    if (!followingBottom) {
      cancelScheduledScrollToBottom()
      return
    }

    clearDetachedMessagesIfNeeded()
  }

  function handleTranscriptTouchStart() {
    interactionReleaseJobId += 1
    userInteracting = true
    forceFollowUntil = 0
    clearForceFollowTimers()
    stopForceFollowObserver()
    cancelScheduledScrollToBottom()
  }

  function scheduleInteractionRelease() {
    const jobId = interactionReleaseJobId + 1
    interactionReleaseJobId = jobId

    nextTick(() => {
      if (jobId !== interactionReleaseJobId) {
        return
      }

      requestAnimationFrame(() => {
        if (jobId !== interactionReleaseJobId) {
          return
        }

        userInteracting = false
        followingBottom = isTranscriptNearBottom()
        clearDetachedMessagesIfNeeded()
      })
    })
  }

  function handleTranscriptTouchMove() {
    userInteracting = true
    forceFollowUntil = 0
    clearForceFollowTimers()
    stopForceFollowObserver()
    cancelScheduledScrollToBottom()
  }

  function handleTranscriptTouchEnd() {
    scheduleInteractionRelease()
  }

  function scheduleScrollToBottom(options = {}) {
    const { force = false } = options
    if (force) {
      resetAutoStickToBottom()
    }

    cancelScheduledScrollToBottom()
    const jobId = pendingScrollJobId

    nextTick(() => {
      const element = transcriptRef?.value
      if (!element || jobId !== pendingScrollJobId) {
        return
      }

      if (!force && !shouldAutoFollow()) {
        setHasNewerMessages(true)
        return
      }

      const run = () => {
        const currentElement = transcriptRef?.value
        if (!currentElement || jobId !== pendingScrollJobId) {
          return
        }

        currentElement.scrollTop = currentElement.scrollHeight
        followingBottom = true
        setHasNewerMessages(false)
      }

      run()
      const firstFrameId = requestAnimationFrame(() => {
        run()
        const secondFrameId = requestAnimationFrame(run)
        pendingScrollFrameIds = [secondFrameId]
      })
      pendingScrollFrameIds = [firstFrameId]
    })
  }

  function scrollToBottom() {
    scheduleScrollToBottom({ force: true })
  }

  function beginForceFollowWindow(options = {}) {
    const durationMs = Number(options.durationMs)
    const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : TASK_SWITCH_FORCE_FOLLOW_MS)
    const timerApi = getTimerApi()
    resetAutoStickToBottom()
    forceFollowUntil = Date.now() + duration
    clearForceFollowTimers()
    stopForceFollowObserver()

    if (timerApi) {
      forceFollowTickTimerIds = TASK_SWITCH_FORCE_FOLLOW_TICK_DELAYS.map((delay) => timerApi.setTimeout(() => {
        if (!isForceFollowing()) {
          return
        }
        scheduleScrollToBottom({ force: true })
      }, delay))

      forceFollowEndTimerId = timerApi.setTimeout(() => {
        forceFollowUntil = 0
        forceFollowEndTimerId = 0
        clearForceFollowTimers()
        stopForceFollowObserver()
      }, duration + 40)
    }

    if (typeof window !== 'undefined') {
      if (typeof window.ResizeObserver === 'function') {
        forceFollowResizeObserver = new window.ResizeObserver(() => {
          if (!isForceFollowing()) {
            return
          }
          scheduleScrollToBottom({ force: true })
        })

        if (transcriptRef?.value) {
          forceFollowResizeObserver.observe(transcriptRef.value)
        }
      }
    }

    scheduleScrollToBottom({ force: true })
  }

  function destroy() {
    interactionReleaseJobId += 1
    forceFollowUntil = 0
    clearForceFollowTimers()
    stopForceFollowObserver()
    cancelScheduledScrollToBottom()
  }

  return {
    cancelScheduledScrollToBottom,
    destroy,
    handleTranscriptScroll,
    handleTranscriptTouchEnd,
    handleTranscriptTouchMove,
    handleTranscriptTouchStart,
    beginForceFollowWindow,
    isTranscriptNearBottom,
    resetAutoStickToBottom,
    scheduleScrollToBottom,
    scrollToBottom,
  }
}
