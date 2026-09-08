import { z } from 'zod'

export const EnvironmentKindSchema = z.enum(['local', 'worktree'])
export const EnvironmentStatusSchema = z.enum(['ready', 'dirty', 'clean', 'missing', 'removed', 'unavailable'])
export const ExecutionEnvironmentSchema = z.object({
  id: z.string().min(1), kind: EnvironmentKindSchema, cwd: z.string().min(1), repositoryRoot: z.string().min(1), branchName: z.string(), baseRef: z.string(), baseCommit: z.string(), worktreePath: z.string().nullable(), ownership: z.enum(['promptx', 'external']), status: EnvironmentStatusSchema, createdAt: z.string(), updatedAt: z.string(),
})

export const RemoveWorktreeInputSchema = z.object({
  force: z.boolean().default(false),
})

export const RebindEnvironmentInputSchema = z.object({
  cwd: z.string().trim().min(1),
  repositoryRoot: z.string().trim().min(1).optional(),
})
