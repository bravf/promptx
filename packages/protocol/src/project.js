import { z } from 'zod'

export const ProjectSchema = z.object({
  id: z.string().min(1), repositoryRoot: z.string().min(1), displayName: z.string(), defaultBranch: z.string(),
  createdAt: z.string(), updatedAt: z.string(), lastOpenedAt: z.string(),
})

export const CreateProjectInputSchema = z.object({
  repositoryRoot: z.string().trim().min(1),
  displayName: z.string({ error: '工作区名称必须是文本。' }).trim().max(120, '工作区名称不能超过 120 个字符。').optional(),
  defaultBranch: z.string({ error: '默认分支必须是文本。' }).trim().optional(),
})
export const UpdateProjectInputSchema = CreateProjectInputSchema.pick({ displayName: true, defaultBranch: true })
