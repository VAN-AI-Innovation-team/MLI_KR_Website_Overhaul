import assert from "node:assert/strict";
import { DEMO_CODE, startDemoServer } from "./demo.mjs";

const server = await startDemoServer({ port: 0 });
function browser() {
  const cookies = new Map();
  return {
    async call(
      path,
      { method = "GET", body, csrf, origin = server.origin } = {},
    ) {
      const headers = new Headers();
      if (origin) headers.set("Origin", origin);
      // A cookie from the regular development server must never authenticate or
      // be overwritten by the independently running demo server.
      headers.set(
        "Cookie",
        [
          "mli_session=regular-server-cookie",
          ...[...cookies].map(([name, value]) => `${name}=${value}`),
        ].join("; "),
      );
      if (body !== undefined) headers.set("Content-Type", "application/json");
      if (csrf) headers.set("X-CSRF-Token", csrf);
      const response = await fetch(`${server.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const cookie of response.headers.getSetCookie()) {
        assert.ok(cookie.startsWith("mli_demo_"));
        assert.ok(cookie.includes("HttpOnly"));
        const [name, value] = cookie.split(";")[0].split("=");
        if (cookie.includes("Max-Age=0")) cookies.delete(name);
        else cookies.set(name, value);
      }
      return { response, body: await response.json() };
    },
  };
}

async function login(client, account) {
  const challenge = await client.call("/api/auth/challenge", {
    method: "POST",
  });
  assert.equal(challenge.response.status, 200);
  const credential = await client.call("/demo/credential", {
    method: "POST",
    body: { account, nonce: challenge.body.nonce },
  });
  assert.equal(credential.response.status, 200);
  const result = await client.call("/api/auth/google", {
    method: "POST",
    body: {
      credential: credential.body.credential,
      csrfToken: challenge.body.csrfToken,
    },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

try {
  for (const path of ["/", "/style.css", "/app.js"]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 200);
    assert.ok(
      response.headers
        .get("Content-Security-Policy")
        .includes("default-src 'self'"),
    );
  }
  const member = browser();
  assert.equal((await member.call("/api/me")).response.status, 401);
  assert.equal(
    (
      await member.call("/demo/credential", {
        method: "POST",
        body: {},
        origin: null,
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await member.call("/demo/credential", {
        method: "POST",
        body: { account: "unlisted", nonce: "a".repeat(43) },
      })
    ).response.status,
    400,
  );
  assert.equal(
    (await member.call("/api/demo/credential", { method: "POST", body: {} }))
      .response.status,
    404,
  );
  const memberSession = await login(member, "member");
  const memberPosts = (await member.call("/api/me/posts")).body.items;
  assert.equal(memberPosts.length, 1);
  assert.ok(memberPosts[0].title.startsWith("test"));
  const other = browser();
  await login(other, "other");
  const otherPosts = (await other.call("/api/me/posts")).body.items;
  assert.equal(otherPosts.length, 1);
  assert.notEqual(otherPosts[0].id, memberPosts[0].id);
  assert.equal(
    (
      await member.call("/api/admin/session", {
        method: "POST",
        body: { code: DEMO_CODE },
        csrf: memberSession.csrfToken,
      })
    ).response.status,
    403,
  );
  const operator = browser();
  const operatorSession = await login(operator, "operator");
  assert.equal(
    (
      await operator.call("/api/me", {
        method: "PATCH",
        body: { nickname: "수정 테스트" },
      })
    ).response.status,
    403,
  );
  const saved = await operator.call("/api/me", {
    method: "PATCH",
    body: { nickname: "수정된 시연 운영자" },
    csrf: operatorSession.csrfToken,
  });
  assert.equal(saved.response.status, 200);
  assert.equal(
    (await operator.call("/api/me")).body.user.nickname,
    "수정된 시연 운영자",
  );
  const rejected = await operator.call("/api/admin/session", {
    method: "POST",
    body: { code: "invalid-demo-code" },
    csrf: operatorSession.csrfToken,
  });
  assert.equal(rejected.response.status, 403);
  const granted = await operator.call("/api/admin/session", {
    method: "POST",
    body: { code: DEMO_CODE },
    csrf: operatorSession.csrfToken,
  });
  assert.equal(granted.response.status, 200);
  assert.equal((await operator.call("/api/admin/session")).body.role, "admin");
  assert.equal(
    (
      await operator.call("/api/auth/logout", {
        method: "POST",
        csrf: operatorSession.csrfToken,
      })
    ).response.status,
    200,
  );
  assert.equal((await operator.call("/api/me")).response.status, 401);
  assert.equal(
    (await operator.call("/api/admin/session")).response.status,
    401,
  );
  const summary = (await operator.call("/demo/state")).body;
  assert.equal(summary.opsTables, 18);
  assert.equal(summary.publicTables, 6);
  assert.equal(summary.views, 2);
  assert.equal(summary.users, 3);
  assert.equal(summary.adminSessions, 0);
  console.log(
    "PASS: demo HTTP server, isolated cookies, signed login, owner filtering, profile storage, admin checks, logout",
  );
} finally {
  await server.close();
}
