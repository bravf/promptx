<script setup>
defineProps({ bodyClass: { type: String, default: '' } })
</script>
<template>
  <section class="inline-settings-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <div class="overflow-hidden" :class="bodyClass"><slot /></div>
  </section>
</template>

<style scoped>
.inline-settings-panel { container-type: inline-size; background: var(--theme-appPanel); }
.inline-settings-panel :deep(.v2-settings-nav) { border-right: 0; }
@container (max-width: 620px) {
  .inline-settings-panel > :deep(.v2-settings-body) { flex-direction: column; }
  :deep(.v2-settings-nav) { width: auto; border-right: 0; border-bottom: 1px solid var(--theme-borderDefault); padding: 0.5rem; }
  :deep(.v2-settings-nav nav) { flex-direction: row; overflow-x: auto; }
  :deep(.v2-settings-nav-item) { width: auto; }
  :deep(.v2-settings-content) { padding: 1rem; }
}
</style>
