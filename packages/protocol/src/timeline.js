import { z } from 'zod'

export { projectTimelineRows } from './timelineProjection.js'

const TextContentBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
const ImageContentBlockSchema = z.object({
  type: z.literal('image'),
  assetId: z.string(),
  mimeType: z.string(),
  name: z.string(),
})

const ToolDetailSchema = z.object({ type: z.string().min(1) }).passthrough()

export const TimelineItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user_message'),
    clientMessageId: z.string(),
    content: z.array(z.union([TextContentBlockSchema, ImageContentBlockSchema])),
  }),
  z.object({
    type: z.literal('assistant_message'),
    messageId: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('reasoning'),
    messageId: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string(),
    name: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled']),
    detail: ToolDetailSchema,
    error: z.object({ message: z.string() }).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('todo'),
    items: z.array(z.object({
      text: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed']),
    })),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('system_notice'), code: z.string(), text: z.string() }),
])

export const TimelineRowSchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
  item: TimelineItemSchema,
})

export const TimelineCursorSchema = z.object({
  epoch: z.string().min(1),
  seq: z.number().int().nonnegative(),
})
