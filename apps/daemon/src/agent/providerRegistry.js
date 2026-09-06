import { codexProvider } from './providers/codex.js'
import { claudeProvider } from './providers/claude.js'
import { kimiProvider } from './providers/acp.js'

export class ProviderRegistry {
  constructor(providers = [codexProvider, claudeProvider, kimiProvider]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  list() {
    return [...this.providers.values()].map(({ id, label, capabilities }) => ({ id, label, capabilities }))
  }

  get(id) {
    const provider = this.providers.get(id)
    if (!provider) {
      const error = new Error(`不支持的 Provider：${id}`)
      error.statusCode = 400
      error.code = 'unsupported_provider'
      throw error
    }
    return provider
  }
}
