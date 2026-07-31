/**
 * Crawler-facing behaviour of the static client.
 *
 * The reason this is worth a test file: every assertion here has NO visible
 * symptom when it breaks. The page loads, the server logs nothing unusual, and
 * the failure surfaces weeks later as "why are we not in search results". A
 * `X-Robots-Tag: noindex` that leaks onto `/` is the worst of them, and it is
 * one refactor away — moving the fallback ahead of the static handler, or
 * dropping the `index: 'index.html'` behaviour, would do it silently.
 *
 * Served against a real temporary `dist/`, not a mock, because the thing being
 * checked is precisely which handler answers a given URL.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import staticClient, { cacheControlFor } from './staticClient.js';

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-static-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Target: Calamity</title>');
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *\n');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(0)');

  app = Fastify();
  await app.register(staticClient, { root });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the homepage is indexable', () => {
  it('serves / from static WITHOUT the noindex header', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    // The whole point. `/` must be answered by fastify-static, never by the
    // SPA fallback, or the site removes itself from search results silently.
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  it('serves /index.html without the noindex header either', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-robots-tag']).toBeUndefined();
  });
});

describe('unknown paths', () => {
  it('returns the shell so a client-side route can resolve', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/deep/route' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Target: Calamity');
  });

  it('marks the shell noindex', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/deep/route' });
    // Without this, /anything is an indexable duplicate of the homepage and
    // there are infinitely many of them.
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('still 404s JSON under /api/ rather than serving HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('404s a non-GET rather than serving the shell', async () => {
    const res = await app.inject({ method: 'POST', url: '/whatever' });
    expect(res.statusCode).toBe(404);
  });
});

describe('cache policy', () => {
  it('pins content-hashed assets for a year', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('makes index.html revalidate', async () => {
    // Caching the shell hard would serve the previous build's HTML, pointing
    // at asset filenames that no longer exist, until the TTL expired.
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('makes robots.txt revalidate — its name is stable across deploys', async () => {
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('splits on the assets folder, not on the file extension', () => {
    // A .js outside assets/ is not hashed and must not be pinned; a .png
    // inside it is. Keying on extension would get both backwards.
    expect(cacheControlFor(join('dist', 'sw.js'))).toBe('no-cache');
    expect(cacheControlFor(join('dist', 'assets', 'logo-9f2c1a.png'))).toContain('immutable');
  });
});
