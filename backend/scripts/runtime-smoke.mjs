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
  intake: true,
});
const { simulator, ops, policies } = runtime;

try {
  const cookies = new Map();
  async function call(path, method = "GET", body, csrf, extraHeaders = {}) {
    const headers = new Headers({ Origin: origin, ...extraHeaders });
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
  assert.deepEqual((await call('/api/health')).body, { status: 'ok', stage: 3 });
  const intakeConfig = await call('/api/intake/config');
  assert.equal(intakeConfig.status, 200);
  const intakeBody = {
    name: '런타임 신청자', email: 'intake@example.invalid', consultationType: 'individual', topic: '런타임 상담 원문',
    consent: { privacy: true, privacyVersion: runtime.intakePrivacyVersion },
    turnstileToken: `consultation:${crypto.randomUUID()}`,
  };
  const requestKey = crypto.randomUUID();
  const intake = await call('/api/consultations', 'POST', intakeBody, undefined, { 'Idempotency-Key': requestKey });
  assert.equal(intake.status, 201, JSON.stringify(intake.body));
  const replay = await call('/api/consultations', 'POST', intakeBody, undefined, { 'Idempotency-Key': requestKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receiptNumber, intake.body.receiptNumber);
  assert.equal((await call('/api/consultations', 'POST', { ...intakeBody, topic: '다른 내용' }, undefined,
    { 'Idempotency-Key': requestKey })).status, 409);
  assert.equal((await call('/api/consultations', 'POST', intakeBody, undefined,
    { 'Idempotency-Key': crypto.randomUUID() })).status, 403);
  assert.equal((await call('/api/inquiries', 'POST', {
    name: '런타임 문의자', email: 'contact@example.invalid', inquiryType: 'partnership', message: '협업 문의',
    consent: intakeBody.consent, turnstileToken: `inquiry:${crypto.randomUUID()}`,
  }, undefined, { 'Idempotency-Key': crypto.randomUUID() })).status, 201);
  assert.equal((await call('/api/admin/consultations')).status, 401);
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
  const admin = await call('/api/admin/session', 'POST', { code }, member.body.csrfToken);
  assert.equal(admin.status, 200);
  assert.equal((await call("/api/admin/session")).body.role, "consultant");
  const list = await call('/api/admin/consultations?status=new');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.total, 1);
  const id = list.body.items[0].id;
  const detailPath = `/api/admin/consultations/${id}`;
  const detail = await call(detailPath);
  assert.equal(detail.body.item.topic, intakeBody.topic);
  assert.ok(!('request_hash' in detail.body.item));
  assert.equal((await call(detailPath, 'PATCH', { version: 1, status: 'reviewing' }, member.body.csrfToken)).status, 403);
  const changed = await call(detailPath, 'PATCH', { version: 1, status: 'reviewing', assignedAdminId: member.body.user.id }, admin.body.csrfToken);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.item.version, 2);
  const competing = await Promise.all(['첫 수정', '동시 수정'].map(internalNote =>
    call(detailPath, 'PATCH', { version: 2, internalNote }, admin.body.csrfToken)));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.equal((await ops.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'intake.updated'").first()).n, 2);
  await ops.prepare("CREATE TRIGGER runtime_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'intentional-runtime-audit-failure'); END").run();
  assert.equal((await call(detailPath, 'PATCH', { version: 3, internalNote: '롤백할 메모' }, admin.body.csrfToken)).status, 503);
  assert.equal((await ops.prepare('SELECT version FROM consultations WHERE id = ?').bind(id).first()).version, 3);
  assert.equal((await call('/api/consultations', 'POST', {
    ...intakeBody, email: 'rollback@example.invalid', turnstileToken: `consultation:${crypto.randomUUID()}`,
  }, undefined, { 'Idempotency-Key': crypto.randomUUID() })).status, 503);
  assert.equal((await ops.prepare('SELECT count(*) AS n FROM consultations').first()).n, 1);
  assert.equal((await ops.prepare('SELECT count(*) AS n FROM intake_token_redemptions').first()).n, 2);
  await ops.prepare('DROP TRIGGER runtime_audit_failure').run();
  assert.equal((await call('/api/admin/inquiries')).body.total, 1);
  assert.equal((await call('/api/admin/audit-events')).status, 403);
  await ops.prepare("UPDATE admin_memberships SET role = 'admin' WHERE user_id = ?").bind(member.body.user.id).run();
  const events = await call(`/api/admin/audit-events?targetId=${id}`);
  assert.equal(events.status, 200);
  assert.equal(events.body.items.length, 4);
  assert.ok(!JSON.stringify(events.body).includes(intakeBody.topic));
  assert.equal(
    (await call("/api/auth/logout", "POST", undefined, member.body.csrfToken))
      .status,
    200,
  );
  assert.equal((await call("/api/me")).status, 401);
  assert.equal((await call("/api/admin/session")).status, 401);
  console.log(
    'PASS: built Worker + local D1: signed login, anonymous intake, Turnstile verification and reuse guard, receipt replay, admin permissions, optimistic edits, atomic audit rollback, logout',
  );
} finally {
  await runtime.dispose();
}
