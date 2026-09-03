<template>
  <div class="app-shell">
    <main class="app-main flex min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-4 sm:py-4 lg:px-4 lg:py-4">
      <div class="app-stage h-full min-h-0 w-full overflow-hidden">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<style scoped>
@media (max-width: 720px) {
  .app-main { padding: 0; }
}
</style>
