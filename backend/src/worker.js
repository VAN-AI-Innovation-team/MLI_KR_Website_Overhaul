const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/health') {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return Response.json({ error: 'METHOD_NOT_ALLOWED' }, {
        status: 405, headers: { ...headers, Allow: 'GET' },
      });
    }

    try {
      // Probe the schema, without reading personal information or counting users.
      await Promise.all([
        env.CONTENT_DB.prepare('SELECT id FROM published_posts LIMIT 0').all(),
        env.OPS_DB.prepare('SELECT id FROM users LIMIT 0').all(),
      ]);
      return Response.json({ status: 'ok', stage: 1 }, { headers });
    } catch {
      // Never send database errors, SQL, bindings, or request contents to clients.
      return Response.json({ status: 'unavailable' }, { status: 503, headers });
    }
  },
};
