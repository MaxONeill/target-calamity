import { sql } from 'kysely';
import type { Database } from '../db.js';

/** The channel `server/routes/stream.ts` LISTENs on. */
const NOTIFY_CHANNEL = 'factor_updates';

/**
 * Tell connected clients the field changed.
 *
 * The client fetches `/api/field` ONCE and refetches only when the stream says
 * something moved. Ingestion writes emit this notify inside their transaction
 * (see `pgRepository.notifyFactorDelta`), but the backfill and resolver scripts
 * were plain UPDATEs — so re-scoring the whole corpus was invisible to every
 * open browser, which kept rendering and reporting the previous values until
 * someone happened to reload.
 *
 * That was not a cosmetic staleness: a viewer reading a significance of 0.04 on
 * a factor the database had since moved to 0.75 is being shown a number the
 * system no longer stands behind.
 *
 * Sent ONCE per run rather than per row. The field is refetched wholesale, the
 * client debounces a burst into a single refetch anyway, and an empty payload is
 * enough — the stream treats an unparseable delta as "something changed" and
 * falls through to the refetch, which reconciles from the source.
 */
export async function notifyFieldChanged(db: Database): Promise<void> {
  await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${'{}'})`.execute(db);
}
