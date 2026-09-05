import { z } from 'zod'

export const TaskLifecycleSchema = z.enum(['active', 'archived'])
export const TaskSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), title: z.string(), providerId: z.string(), lifecycle: TaskLifecycleSchema,
  environmentId: z.string().min(1), createdAt: z.string(), updatedAt: z.string(), lastActiveAt: z.string(), archivedAt: z.string().nullable(),
})
export const CreateTaskInputSchema = z.object({ title: z.string().trim().max(120).optional(), providerId: z.string().trim().min(1), executionKind: z.enum(['local', 'worktree', 'existing']).default('local'), baseRef: z.string().trim().optional(), branchName: z.string().trim().optional(), slug: z.string().trim().optional(), cwd: z.string().trim().optional() })
