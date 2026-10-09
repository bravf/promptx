import { z } from 'zod'

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(200),
})
export const CreateTerminalSchema = TerminalSizeSchema.extend({
  requestId: z.string().uuid(),
  ensure: z.boolean().default(false),
})
export const RenameTerminalSchema = z.object({ name: z.string().trim().min(1).max(40) })
export const TerminalInputSchema = z.object({ id: z.string().uuid(), data: z.string().min(1).max(32768) })
export const TerminalCursorSchema = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) })

export const StartServiceSchema = z.object({
  name: z.string().trim().min(1).max(40),
  command: z.string().trim().min(1).max(8000),
  cwd: z.string().max(4096).default('.'),
  url: z.string().url().optional(),
  waitMs: z.number().int().min(0).max(15000).default(8000),
}).strict()
export const ServiceIdSchema = z.object({ terminalId: z.string().uuid() }).strict()
export const ServiceLogsSchema = ServiceIdSchema.extend({ cursor: z.number().int().nonnegative().default(0) })
