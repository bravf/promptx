import { z } from 'zod'

const InteractionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(2000),
  description: z.string().max(4000).optional(),
})

export const InteractionRequestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['question', 'choice', 'plan']),
  title: z.string().max(2000),
  delivery: z.enum(['blocking', 'async']).optional(),
  sourceMessageId: z.string().optional(),
  description: z.string().max(32000).optional(),
  questions: z.array(z.object({
    id: z.string().min(1),
    header: z.string().max(2000),
    question: z.string().max(8000),
    options: z.array(InteractionOptionSchema).max(32).default([]),
    multiSelect: z.boolean().default(false),
    allowOther: z.boolean().default(false),
    secret: z.boolean().default(false),
  })).max(32).default([]),
  actions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().max(2000),
  })).max(32).default([]),
})

export const InteractionResponseSchema = z.object({
  decision: z.enum(['answer', 'dismiss']),
  actionId: z.string().optional(),
  answers: z.record(z.string(), z.object({
    optionIds: z.array(z.string()).max(32).default([]),
    text: z.string().max(8000).default(''),
  })).optional(),
})

export { normalizeInteractionQuestions, validateInteractionResponse } from './interactionAnswers.js'
