// Demo data for `rer demo` (modules/demo runs it once, after the owner exists).
// It is the reference's own sample content: the public record the end-to-end
// fixture serves, and one finished job and cron run for the operator dashboard.
// The owner has confirmed first run, so the demo opens on the app itself.
// Fixed IDs keep it idempotent.
import { drizzle } from 'drizzle-orm/d1'
import { articles, jobs, scheduledRuns } from './core/platform/db/schema'
import type { Bindings } from './core/platform/bindings.server'

export async function seedDemo(env: Bindings, { ownerEmail, now }: { ownerEmail: string; now: Date }): Promise<void> {
  const db = drizzle(env.DB), at = now.toISOString()
  await env.DB.prepare("INSERT INTO oa_first_run (singleton, completed_by, completed_at) SELECT 1, id, ? FROM oa_operators WHERE email = ? AND role = 'owner' ON CONFLICT(singleton) DO NOTHING").bind(now.getTime(), ownerEmail).run()
  await db.insert(articles).values([
    { id: '01K4KX4S000000000000000001', slug: 'worker-boundaries', title: 'Worker boundaries', body: 'This record is loaded from D1 during server rendering.', publishedAt: '2026-09-08T00:00:00.000Z' },
    { id: '01K4KX4S000000000000000002', slug: 'demo-mode', title: 'Demo mode', body: 'This copy runs on its own throwaway data. Mail lands in the outbox and nothing is sent.', publishedAt: at },
  ]).onConflictDoNothing()
  await db.insert(jobs).values({ id: '01K4KX4S000000000000000003', kind: 'reference.lifecycle.v1', state: 'completed', createdAt: at, completedAt: at }).onConflictDoNothing()
  await db.insert(scheduledRuns).values({ id: '01K4KX4S000000000000000004', cron: '*/10 * * * *', ranAt: at }).onConflictDoNothing()
}
