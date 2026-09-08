import { z } from 'zod'

export const TaskLifecycleSchema = z.enum(['active', 'archived'])
export const TaskSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), title: z.string(), providerId: z.string(), lifecycle: TaskLifecycleSchema,
  environmentId: z.string().min(1), createdAt: z.string(), updatedAt: z.string(), lastActiveAt: z.string(),
  archivedAt: z.string().nullable(), pinnedAt: z.string().nullable(),
})
export const CreateTaskInputSchema = z.object({ title: z.string().trim().max(120).optional(), providerId: z.string().trim().min(1), executionKind: z.enum(['local', 'worktree', 'existing']).default('local'), baseRef: z.string().trim().optional(), branchName: z.string().trim().optional(), slug: z.string().trim().optional(), cwd: z.string().trim().optional() })
export const UpdateTaskInputSchema = z.object({
  title: z.string({ error: '会话名称必须是文本。' }).trim().min(1, '会话名称不能为空。').max(120, '会话名称不能超过 120 个字符。'),
})

export const GitCommitInputSchema = z.object({
  message: z.string().trim().min(1, '提交说明不能为空。').max(200, '提交说明不能超过 200 个字符。'),
})

export const GitMergeInputSchema = z.object({
  targetBranch: z.string().trim().min(1).optional(),
  message: z.string().trim().max(200).optional(),
  archive: z.boolean().default(true),
})
