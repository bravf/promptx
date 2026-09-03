<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps({
  title: {
    type: String,
    default: '',
  },
})

const viewport = ref(null)
const content = ref(null)
const overflowing = ref(false)
const marqueeStyle = ref({})
let resizeObserver = null

function measureOverflow() {
  if (!viewport.value || !content.value) return
  const distance = Math.ceil(content.value.scrollWidth - viewport.value.clientWidth)
  overflowing.value = distance > 1
  marqueeStyle.value = overflowing.value
    ? {
        '--marquee-distance': `-${distance}px`,
        '--marquee-duration': `${Math.max(4, Math.min(16, distance / 32 + 2)).toFixed(2)}s`,
      }
    : {}
}

watch(() => props.title, () => nextTick(measureOverflow))

onMounted(() => {
  resizeObserver = new ResizeObserver(measureOverflow)
  resizeObserver.observe(viewport.value)
  resizeObserver.observe(content.value)
  document.fonts?.ready.then(measureOverflow)
  measureOverflow()
})

onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <span
    ref="viewport"
    class="session-title-marquee"
    :class="{ 'is-overflowing': overflowing }"
    :style="marqueeStyle"
  >
    <span ref="content" class="session-title-marquee__content">{{ title }}</span>
  </span>
</template>

<style scoped>
.session-title-marquee {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.session-title-marquee__content {
  display: inline-block;
  min-width: max-content;
}

.session-title-marquee.is-overflowing:hover .session-title-marquee__content {
  animation: session-title-marquee var(--marquee-duration) ease-in-out infinite alternate;
  will-change: transform;
}

@keyframes session-title-marquee {
  0%, 12% {
    transform: translateX(0);
  }

  88%, 100% {
    transform: translateX(var(--marquee-distance));
  }
}

@media (prefers-reduced-motion: reduce) {
  .session-title-marquee.is-overflowing:hover .session-title-marquee__content {
    animation: none;
  }
}
</style>
