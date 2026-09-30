import { z } from 'zod'

// 多个视图共享事件连接；每个订阅独立携带恢复游标。
export const TaskEventSubscriptionsSchema = z.object({
  subscriptions: z.array(z.object({
    id: z.string().min(1).max(80),
    taskId: z.string().min(1).max(80),
    cursor: z.string().max(160).default(''),
    snapshot: z.boolean().default(true),
    turnsRevision: z.string().max(80).default(''),
    controlRevision: z.string().max(80).default(''),
  })).min(1).max(1000),
}).refine(input => new Set(input.subscriptions.map(item => item.id)).size === input.subscriptions.length, '订阅标识不能重复')
