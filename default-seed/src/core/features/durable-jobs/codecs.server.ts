import { z } from 'zod'

export const SALES_KIND = 'reference.sales.refresh'
export const SALES_NAMESPACE = 'reference.sales'
export const salesInput = z.object({ sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/) }).strict()
export const salesRevision = z.object({ sourceRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/) }).strict()
export const salesCheckpoint = z.object({ after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), rows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
export const saleRow = z.object({ ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), saleId: z.string().min(1).max(100), amountMinor: z.number().int().min(0).max(1_000_000_000), currency: z.literal('USD') }).strict()
export const salesResult = z.object({ sourceId: salesInput.shape.sourceId, sourceRevision: salesRevision.shape.sourceRevision,
  rows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.literal('USD') }).strict()
export const tenantKey = (tenantId: string | null) => tenantId ?? ''
export type SalesInput = z.infer<typeof salesInput>
export type SalesCheckpoint = z.infer<typeof salesCheckpoint>
