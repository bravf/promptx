import '@fontsource/geist-sans/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '@fontsource/geist-sans/latin-700.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import { createApp } from 'vue'
import App from './App.vue'
import './lib/relayOffer.js'
import router from './router.js'
import './styles.css'
import { initializeI18n } from './composables/useI18n.js'
import { initializeTheme } from './composables/useTheme.js'

function reportGlobalError(error) {
  const message = String(error?.message || error || '页面发生未知错误。').trim()
  window.__PROMPTX_GLOBAL_ERROR__ = message
  window.dispatchEvent(new CustomEvent('promptx:global-error', { detail: { message } }))
}

window.addEventListener('error', (event) => reportGlobalError(event.error || event.message))
window.addEventListener('unhandledrejection', (event) => reportGlobalError(event.reason))

initializeTheme()
initializeI18n()

const app = createApp(App)
app.config.errorHandler = (error) => reportGlobalError(error)
app.use(router).mount('#app')
