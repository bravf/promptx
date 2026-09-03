import { z } from 'zod'

export const WorkspaceEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['directory', 'file', 'symlink']),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
})

export const WorkspaceDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(WorkspaceEntrySchema),
})

export const WorkspaceFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
  kind: z.enum(['text', 'image', 'binary', 'too_large']),
  mimeType: z.string(),
  content: z.string().optional(),
})

export const WorkspaceGitFileSchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
  staged: z.boolean(),
  unstaged: z.boolean(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
})

export const WorkspaceGitStatusSchema = z.object({
  available: z.boolean(),
  root: z.string().optional(),
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(WorkspaceGitFileSchema),
})

export const WorkspaceGitDiffSchema = z.object({
  path: z.string(),
  staged: z.string(),
  unstaged: z.string(),
  truncated: z.boolean(),
})
