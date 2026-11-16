import assert from "node:assert/strict";
import { createLocalAuthRuntime } from "./local-auth-runtime.mjs";

// Isolated simulator storage and a test-only outbound service. The built default
// Worker still verifies RS256 signatures at its fixed Google JWKS URL.
const code = "runtime-test-only-admin-code-with-at-least-32-characters";
const origin = "https://runtime-test.example";
const runtime = await createLocalAuthRuntime({
  origin,
  adminCode: code,
  adminSubjects: ["runtime-account"],
});
const { simulator, ops, policies } = runtime;

try {
  const cookies = new Map();
  async function call(path, method = "GET", body, csrf) {
    const headers = new Headers({ Origin: origin });
    headers.set(
      "Cookie",
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );
    if (csrf) headers.set("X-CSRF-Token", csrf);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await simulator.dispatchFetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";")[0].split("=");
      if (cookie.includes("Max-Age=0;") || cookie.endsWith("Max-Age=0"))
        cookies.delete(name);
      else cookies.set(name, value);
    }
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await call("/api/health")).status, 200);
  const challenge = await call("/api/auth/challenge", "POST");
  assert.equal(challenge.status, 200);
  const credential = await runtime.issueCredential({
    subject: "runtime-account",
    email: "runtime@example.invalid",
    nonce: challenge.body.nonce,
  });
  const member = await call("/api/auth/google", "POST", {
    credential,
    csrfToken: challenge.body.csrfToken,
    registration: {
      nickname: "런타임 테스트",
      preferredLanguage: "ko",
      consent: { terms: true, privacy: true, ...policies },
    },
  });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.equal((await call("/api/me")).body.user.id, member.body.user.id);
  assert.equal(
    (
      await call(
        "/api/me",
        "PATCH",
        { nickname: "변경된 닉네임" },
        member.body.csrfToken,
      )
    ).status,
    200,
  );
  assert.equal((await call("/api/me/posts")).status, 200);
  await ops
    .prepare(
      "INSERT INTO admin_memberships (user_id, role) VALUES (?, 'consultant')",
    )
    .bind(member.body.user.id)
    .run();
  assert.equal(
    (await call("/api/admin/session", "POST", { code }, member.body.csrfToken))
      .status,
    200,
  );
  assert.equal((await call("/api/admin/session")).body.role, "consultant");
  assert.equal(
    (await call("/api/auth/logout", "POST", undefined, member.body.csrfToken))
      .status,
    200,
  );
  assert.equal((await call("/api/me")).status, 401);
  assert.equal((await call("/api/admin/session")).status, 401);
  console.log(
    "PASS: built Worker + actual local D1: signed login, profile, ownership query, admin role, logout",
  );
} finally {
  await runtime.dispose();
}
