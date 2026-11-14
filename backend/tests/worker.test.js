import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/worker.js';

function environment(fail = false) {
  const binding = { prepare: () => ({ all: async () => {
    if (fail) throw new Error('private-sql-or-secret');
    return { results: [], success: true };
  } }) };
  return { CONTENT_DB: binding, OPS_DB: binding };
}

test('health verifies both schemas without caching its response', async () => {
  const response = await worker.fetch(new Request('http://localhost/api/health'), environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', stage: 2 });
});

test('database failures return a generic unavailable response', async () => {
  const response = await worker.fetch(new Request('http://localhost/api/health'), environment(true));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private-sql-or-secret'), false);
});

test('intake and administration content APIs remain unavailable in stage 2', async () => {
  for (const path of ['/api/consultations', '/api/admin/consultations', '/api/users']) {
    const response = await worker.fetch(new Request(`http://localhost${path}`), environment());
    assert.equal(response.status, 404);
  }
});

test('health only accepts GET', async () => {
  const response = await worker.fetch(new Request('http://localhost/api/health', { method: 'POST' }), environment());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
