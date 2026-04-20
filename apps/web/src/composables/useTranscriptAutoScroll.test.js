import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTick, ref } from 'vue'

import { useTranscriptAutoScroll } from './useTranscriptAutoScroll.js'

function installWindowStubs() {
  const originalWindow = globalThis.window
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  let nextFrameId = 1

  const requestAnimationFrameStub = (callback) => {
    const frameId = nextFrameId
    nextFrameId += 1
    callback()
    return frameId
  }
  const cancelAnimationFrameStub = () => {}

  globalThis.window = {
    requestAnimationFrame: requestAnimationFrameStub,
    cancelAnimationFrame: cancelAnimationFrameStub,
  }
  globalThis.requestAnimationFrame = requestAnimationFrameStub
  globalThis.cancelAnimationFrame = cancelAnimationFrameStub

  return () => {
    globalThis.window = originalWindow
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  }
}

async function flushScrollScheduling() {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
}

test('在底部时新消息会自动跟随到底部', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 800,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    transcriptRef.value.scrollHeight = 1200

    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 1200)
    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('不在底部时新消息不会抢滚动，只显示跳底提示', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 420,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    autoScroll.handleTranscriptScroll()
    transcriptRef.value.scrollHeight = 1200

    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 420)
    assert.equal(hasNewerMessages.value, true)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('手指开始操作后，即使此刻还在底部，也不会再自动抢滚动', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 800,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    autoScroll.handleTranscriptTouchStart()
    transcriptRef.value.scrollHeight = 1200

    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 800)
    assert.equal(hasNewerMessages.value, true)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('回到底部后会清掉跳底提示，并恢复自动跟随', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1200,
    clientHeight: 200,
    scrollTop: 420,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    autoScroll.handleTranscriptScroll()
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(hasNewerMessages.value, true)
    assert.equal(transcriptRef.value.scrollTop, 420)

    transcriptRef.value.scrollTop = 1000
    autoScroll.handleTranscriptScroll()
    assert.equal(hasNewerMessages.value, false)

    transcriptRef.value.scrollHeight = 1400
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 1400)
    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('仅仅滚离底部但没有新消息时，不显示跳底提示', () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 520,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    autoScroll.handleTranscriptScroll()

    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('切任务后会重置离底状态并强制跟到底部', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 420,
  })
  const hasNewerMessages = ref(true)

  try {
    const autoScroll = useTranscriptAutoScroll({ transcriptRef, hasNewerMessages })
    autoScroll.handleTranscriptScroll()
    autoScroll.beginForceFollowWindow({ durationMs: 200 })
    transcriptRef.value.scrollHeight = 1400
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 1400)
    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})
