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
import { initializeWorkbenchPreferences } from './lib/workbenchPreferences.js'

initializeTheme()
initializeI18n()
initializeWorkbenchPreferences()

createApp(App).use(router).mount('#app')
