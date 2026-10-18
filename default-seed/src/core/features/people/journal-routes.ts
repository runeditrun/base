import type { Hono } from 'hono'
import { readD1ErasureJournal } from '../../../../../modules/import-kit/src/d1/index.ts'
import type { Session } from '../../../../../modules/operator-auth/index.mjs'
import type { Bindings } from '../../platform/bindings.server'
import { peopleImportContext } from './imports.server'

type Environment = { Bindings: Bindings; Variables: { session: Session; files: R2Bucket } }

/** The import-custody erasure journal remains part of the public owner API. */
export function journalRoutes(app: Hono<Environment>) {
  app.get('/api/erasures/journal', async (c) => c.json({ journal: await readD1ErasureJournal(peopleImportContext(c.env.DB, c.get('session').operator)) }))
}
