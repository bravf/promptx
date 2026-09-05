import { z } from 'zod'

export const EnvironmentKindSchema = z.enum(['local', 'worktree'])
export const EnvironmentStatusSchema = z.enum(['creating', 'ready', 'running', 'dirty', 'clean', 'orphaned', 'missing', 'archiving', 'archived', 'unavailable'])
export const ExecutionEnvironmentSchema = z.object({
  id: z.string().min(1), kind: EnvironmentKindSchema, cwd: z.string().min(1), repositoryRoot: z.string().min(1), branchName: z.string(), baseRef: z.string(), worktreePath: z.string().nullable(), ownership: z.enum(['promptx', 'external']), status: EnvironmentStatusSchema, createdAt: z.string(), updatedAt: z.string(),
})
