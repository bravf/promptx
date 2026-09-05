import { z } from 'zod'

export const ProviderIds = Object.freeze({
  CODEX: 'codex',
  CLAUDE: 'claude',
  KIMI: 'kimi',
})

export const AgentLifecycleSchema = z.enum([
  'initializing',
  'ready',
  'running',
  'stopping',
  'recovering',
  'failed',
  'archived',
  'closing',
])

export const AgentSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  title: z.string(),
  lifecycle: AgentLifecycleSchema,
  modelId: z.string(),
  modeId: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  lastError: z.string(),
  requiresAttention: z.boolean(),
  attentionReason: z.enum(['finished', 'error', 'permission']).nullable(),
  attentionAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActiveAt: z.string(),
  archivedAt: z.string().nullable(),
})

export const CreateAgentInputSchema = z.object({
  providerId: z.string().trim().min(1),
  title: z.string().trim().max(120).optional(),
  modelId: z.string().trim().optional().default(''),
  modeId: z.string().trim().optional().default(''),
  providerConfig: z.record(z.string(), z.unknown()).optional().default({}),
})

export const AgentModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional().default(''),
  reasoningEfforts: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional().default(''),
  })).optional().default([]),
  defaultReasoningEffort: z.string().optional().default(''),
})

export const AgentContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive(),
  percentage: z.number().min(0).max(100),
  updatedAt: z.string(),
})

export const AgentControlStateSchema = z.object({
  models: z.array(AgentModelOptionSchema),
  currentModelId: z.string(),
  reasoningEfforts: AgentModelOptionSchema.shape.reasoningEfforts,
  currentReasoningEffort: z.string(),
  contextUsage: AgentContextUsageSchema.nullable(),
})

export const UpdateAgentSettingsInputSchema = z.object({
  modelId: z.string().trim().min(1).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
}).refine((input) => input.modelId !== undefined || input.reasoningEffort !== undefined, {
  message: '至少需要提供一项 Agent 设置。',
})

export const PromptContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    assetId: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('file'),
    assetId: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
  }),
])

export const AgentPromptInputSchema = z.object({
  content: z.array(PromptContentBlockSchema).min(1),
})

export const CreateTurnInputSchema = z.object({
  clientMessageId: z.string().trim().min(1),
  input: AgentPromptInputSchema,
})

export const TurnStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'canceled'])

export const AgentTurnSchema = z.object({
  id: z.string().min(1),
  agentSessionId: z.string().min(1),
  clientMessageId: z.string().min(1),
  nativeTurnId: z.string(),
  status: TurnStatusSchema,
  errorMessage: z.string(),
  usage: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
