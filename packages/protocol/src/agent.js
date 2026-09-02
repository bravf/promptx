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
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  title: z.string(),
  lifecycle: AgentLifecycleSchema,
  modelId: z.string(),
  modeId: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  lastError: z.string(),
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

export const PromptContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    assetId: z.string().min(1),
    mimeType: z.string().min(1),
    name: z.string().min(1),
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
