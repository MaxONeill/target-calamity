/**
 * Serving the built client, and the crawler-facing consequences of doing it
 * this way.
 *
 * This lives in its own plugin rather than inline in `index.ts` so it can be
 * registered against a bare Fastify instance in a test. The behaviour worth
 * testing is not "does it serve a file" — it is that `/` is indexable and
 * everything else is not, which is a distinction with no visible symptom. Get
 * it backwards and the site simply stops appearing in search results, with the
 * server logging nothing and every page still loading perfectly.
 */
import { sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Vite content-hashes into this folder; nothing else in `dist/` is hashed. */
const HASHED_DIR = `${sep}assets${sep}`;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/** Exported for test: the Cache-Control a given on-disk path should carry. */
export function cacheControlFor(path: string): string {
  return path.includes(HASHED_DIR) ? IMMUTABLE : REVALIDATE;
}

/**
 * In production the Fastify server also serves the built client, so the whole
 * app is one origin and there is no CORS surface (matching the dev proxy). In
 * dev the client is served by Vite, so `index.ts` skips this when `dist/` is
 * absent. API routes are registered first and win; the SPA fallback returns
 * `index.html` only for non-API GETs so client-side routes resolve.
 */
export default async function staticClient(
  app: FastifyInstance,
  opts: { root: string },
): Promise<void> {
  await app.register(fastifyStatic, {
    root: opts.root,
    wildcard: false,
    // Off, so setHeaders is the only thing writing Cache-Control. Left on, the
    // plugin's own `public, max-age=0` lands on every response and the split
    // policy below is silently a no-op — which is exactly what happened the
    // first time this was written.
    cacheControl: false,
    /*
     * Two policies, split on whether the filename pins the content.
     *
     * A hashed name can never change meaning — a new build produces a new name
     * — so those pin for a year, and `immutable` additionally saves browsers a
     * revalidation round-trip on reload.
     *
     * Everything else keeps a stable name across deploys: index.html above all,
     * but also og.png, the icons, robots.txt and sitemap.xml. Caching those
     * hard would serve the previous build's HTML, pointing at asset filenames
     * that no longer exist, until the TTL ran out. `no-cache` still permits
     * caching; it requires revalidation, which is a 304 on the common path.
     */
    setHeaders(reply, path) {
      void reply.header('Cache-Control', cacheControlFor(path));
    },
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    /*
     * Unknown paths get the shell so a client-side route can resolve, which
     * means /anything answers 200 with the full page. To a crawler that is an
     * unbounded supply of URLs all serving identical content, and every one of
     * them is a candidate to be indexed in place of the real address.
     *
     * `index.html` carries <meta name="robots" content="index, follow">; this
     * header says the opposite for everything arriving here instead, and an
     * X-Robots-Tag header outranks the document meta. The load-bearing part is
     * that `/` is served by fastify-static above and never reaches this
     * handler — if it ever did, the homepage would go noindex and the only
     * symptom would be the site quietly leaving search results.
     */
    void reply.header('X-Robots-Tag', 'noindex');
    reply.sendFile('index.html');
  });
}
