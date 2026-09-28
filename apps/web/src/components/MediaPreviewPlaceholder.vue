<script setup>
import { Image, LoaderCircle, Video } from 'lucide-vue-next'
defineProps({ kind: { type: String, default: 'image' }, error: { type: String, default: '' } })
</script>

<template>
  <div class="media-preview-placeholder rounded-sm" :class="{ 'is-video': kind === 'video' }" :role="error ? 'alert' : 'status'" :aria-busy="!error">
    <component :is="kind === 'video' ? Video : Image" class="h-10 w-10" aria-hidden="true" />
    <div class="flex items-center justify-center gap-2 text-sm font-medium">
      <LoaderCircle v-if="!error" class="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span>{{ error || (kind === 'video' ? '正在加载视频' : '正在加载图片') }}</span>
    </div>
    <p v-if="!error" class="theme-muted-text text-xs">加载完成后将自动显示</p>
    <slot />
    <div v-if="kind === 'video'" class="media-preview-placeholder__track" aria-hidden="true" />
  </div>
</template>

<style scoped>
.media-preview-placeholder {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  width: min(40rem, calc(100vw - 3rem));
  height: min(30rem, calc(100dvh - 8rem), calc((100vw - 3rem) * 0.75));
  min-height: min(11rem, calc(100dvh - 8rem));
  padding: 1rem;
  border: 1px solid var(--theme-borderStrong);
  background: var(--theme-appBg);
  color: var(--theme-textPrimary);
  box-shadow: 0 16px 48px var(--theme-modalBackdrop);
}
.media-preview-placeholder.is-video {
  width: min(60rem, calc(100vw - 2rem));
  height: min(33.75rem, calc(100dvh - 8rem), calc((100vw - 2rem) * 0.5625));
}
.media-preview-placeholder__track {
  position: absolute;
  bottom: 1rem;
  left: 1rem;
  right: 1rem;
  height: 3px;
  background: var(--theme-borderMuted);
}
</style>
