import { randomUUID } from 'node:crypto'
import { InteractionRequestSchema, InteractionResponseSchema, validateInteractionResponse } from '../../../../../packages/protocol/src/interaction.js'

function unavailable() {
  return Object.assign(new Error('这个问题已回答或已失效，请查看最新状态。'), { statusCode: 409, code: 'interaction_unavailable' })
}

export class PendingInteractions {
  constructor(runtime) {
    this.runtime = runtime
    this.pending = new Map()
  }

  get requests() {
    return [...this.pending.values()].map(entry => entry.request)
  }

  ask(input, { respond, signal } = {}) {
    if (signal?.aborted) return Promise.resolve(respond({ decision: 'dismiss' }, {}))
    const request = InteractionRequestSchema.parse({ ...input, id: randomUUID() })
    if (this.pending.size >= 32) throw new Error('等待回答的问题过多，请先处理现有问题。')
    if (request.kind === 'question' && !request.questions.length) throw new Error('Agent 返回了空的问题列表。')
    if (new Set(request.questions.map(question => question.id)).size !== request.questions.length) throw new Error('Agent 返回了重复的问题标识。')
    return new Promise((resolve, reject) => {
      const abort = () => this.settle(request.id, { decision: 'dismiss' }, {}, 'expired', 'Agent 已取消这个问题。')
      this.pending.set(request.id, { request, respond, resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.runtime.emit('interaction', { type: 'interaction_request', ...request, status: 'pending' }) } catch (error) {
        this.pending.delete(request.id)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
    })
  }

  answer(id, input) {
    const entry = this.pending.get(id)
    if (!entry) throw unavailable()
    const response = InteractionResponseSchema.parse(input)
    let answers
    try { answers = validateInteractionResponse(entry.request, response) } catch (error) {
      error.statusCode = 400
      throw error
    }
    // 同步取走请求，多个端同时提交时只有一个回答能到达 Provider。
    this.settle(id, response, answers, response.decision === 'answer' ? 'answered' : 'dismissed')
  }

  settle(id, response, answers, status, message) {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.cleanup()
    const savedAnswers = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key,
      entry.request.questions.find(question => question.id === key)?.secret ? ['已提交（隐藏内容）'] : value,
    ]))
    try {
      const result = entry.respond(response, answers)
      this.runtime.emit('interaction', {
        type: 'interaction_request', ...entry.request, status,
        ...(Object.keys(savedAnswers).length ? { answers: savedAnswers } : {}),
        ...(response.actionId ? { selectedAction: entry.request.actions.find(action => action.id === response.actionId)?.label } : {}),
        ...(message ? { message } : {}),
      })
      entry.resolve(result)
    } catch (error) { entry.reject(error); throw error }
  }

  expire(message = '任务已结束，这个问题已失效。', filter = () => true) {
    for (const id of [...this.pending.keys()].filter(filter)) this.settle(id, { decision: 'dismiss' }, {}, 'expired', message)
  }
}
