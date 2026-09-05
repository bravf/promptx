import { z } from 'zod'

export const ProjectSchema = z.object({
  id: z.string().min(1), repositoryRoot: z.string().min(1), displayName: z.string(), defaultBranch: z.string(),
  createdAt: z.string(), updatedAt: z.string(), lastOpenedAt: z.string(),
})

export const CreateProjectInputSchema = z.object({ repositoryRoot: z.string().trim().min(1), displayName: z.string().trim().max(120).optional(), defaultBranch: z.string().trim().optional() })
