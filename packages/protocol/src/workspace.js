import { z } from 'zod'

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOpenedAt: z.string(),
})

export const CreateWorkspaceInputSchema = z.object({
  cwd: z.string().trim().min(1),
  title: z.string().trim().max(120).optional(),
})

export const UpdateWorkspaceInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
})
