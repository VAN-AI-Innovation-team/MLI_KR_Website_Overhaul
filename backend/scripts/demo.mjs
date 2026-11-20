import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalAuthRuntime } from "./local-auth-runtime.mjs";

export const DEMO_CODE = "MLI-DEMO-ADMIN-2026-LOCAL-ONLY-123456";
const ACCOUNTS = [
  {
    key: "member",
    subject: "demo-member",
    nickname: "test",
    label: "test",
    role: "member",
  },
  {
    key: "other",
    subject: "demo-other",
    nickname: "다른 회원",
    label: "다른 회원",
    role: "member",
  },
  {
    key: "operator",
    subject: "demo-operator",
    nickname: "MLI 운영자",
    label: "운영자",
    role: "admin",
  },
];
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/stage3": ["stage3.html", "text/html; charset=utf-8"],
  "/stage3.css": ["stage3.css", "text/css; charset=utf-8"],
  "/stage3.js": ["stage3.js", "text/javascript; charset=utf-8"],
};

async function seed(runtime) {
  const now = Math.floor(Date.now() / 1000);
  for (const account of ACCOUNTS) {
    const userId = crypto.randomUUID();
    const postId = crypto.randomUUID();
    await runtime.ops.batch([
      runtime.ops
        .prepare(
          `INSERT INTO users (id, nickname, terms_version, privacy_version, consented_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          account.nickname,
          runtime.policies.termsVersion,
          runtime.policies.privacyVersion,
          now,
          now,
          now,
        ),
      runtime.ops
        .prepare(
          `INSERT INTO auth_identities (id, user_id, provider, subject, email)
        VALUES (?, ?, 'google', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          userId,
          account.subject,
          `${account.key}@example.invalid`,
        ),
      runtime.ops
        .prepare(
          `INSERT INTO posts (id, board_type, author_id, slug, status, published_at, created_at, updated_at)
        VALUES (?, 'community', ?, ?, 'published', ?, ?, ?)`,
        )
        .bind(postId, userId, `demo-${account.key}`, now, now, now),
      runtime.ops
        .prepare(
          `INSERT INTO post_translations (post_id, locale, title, body)
        VALUES (?, 'ko', ?, ?)`,
        )
        .bind(postId, `${account.label}의 리더십 탐색 기록`, "test"),
      runtime.ops
        .prepare(
          `INSERT INTO comments (id, post_id, author_id, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          postId,
          userId,
          `${account.label} test`,
          now,
          now,
        ),
    ]);
    if (account.role === "admin") {
      await runtime.ops
        .prepare(
          "INSERT INTO admin_memberships (user_id, role) VALUES (?, 'admin')",
        )
        .bind(userId)
        .run();
    }
  }
  const publicId = crypto.randomUUID();
  await runtime.content.batch([
    runtime.content
      .prepare(
        `INSERT INTO published_posts
      (id, board_type, slug, author_display_name, original_language, source_version, published_at, updated_at)
      VALUES (?, 'notice', 'demo-welcome', 'test', 'ko', 1, ?, ?)`,
      )
      .bind(publicId, now, now),
    runtime.content
      .prepare(
        `INSERT INTO published_post_translations (post_id, locale, title, body, source_version)
      VALUES (?, 'ko', 'test', 'test', 1)`,
      )
      .bind(publicId),
  ]);
  const operator = await runtime.ops.prepare("SELECT user_id FROM auth_identities WHERE subject = 'demo-operator'").first();
  const samples = [
    { name: '김민지 (예시)', type: 'individual', status: 'new', topic: '처음 팀장을 맡았습니다. 팀원의 강점을 발견하고 업무를 배분하는 방법을 상담하고 싶습니다.', organization: null, age: 600 },
    { name: '박서연 (예시)', type: 'organization', status: 'reviewing', topic: '구성원 20명을 위한 강점 기반 리더십 워크숍을 준비하고 있습니다. 프로그램과 진행 방식을 논의하고 싶습니다.', organization: '함께성장 팀 (예시)', age: 3600 },
    { name: '최도윤 (예시)', type: 'organization', status: 'proposed', topic: '신임 리더 온보딩 프로그램에 강점 진단과 코칭을 도입하려고 합니다. 가능한 일정과 구성을 문의합니다.', organization: '내일교육 (예시)', age: 86400 },
    { name: '이준호 (예시)', type: 'other', status: 'confirmed', topic: '커리어 전환 과정에서 나의 강점을 정리하고, 앞으로의 리더십 방향을 함께 점검하고 싶습니다.', organization: null, age: 172800 },
  ];
  for (const [index, sample] of samples.entries()) {
    const id = crypto.randomUUID();
    await runtime.ops.batch([
      runtime.ops.prepare(`INSERT INTO consultations
        (id, receipt_number, idempotency_key, request_hash, name, email, phone, consultation_type, topic, organization,
        preferred_time_1, preferred_timezone, preferred_mode, privacy_consent_version, privacy_consented_at,
        status, assigned_admin_id, internal_note, confirmed_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '010-0000-0000', ?, ?, ?, ?, 'Asia/Seoul', 'online', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, `C-DEMO-${String(index + 1).padStart(3, '0')}`, crypto.randomUUID(), 'a'.repeat(64), sample.name,
          `sample${index + 1}@example.invalid`, sample.type, sample.topic, sample.organization, now + (index + 2) * 86400,
          runtime.intakePrivacyVersion, now - sample.age, sample.status, index ? operator.user_id : null,
          index ? '시연용 메모입니다. 신청 내용을 확인하고 다음 일정을 준비해 주세요.' : '',
          sample.status === 'confirmed' ? now + 5 * 86400 : null, now - sample.age, now - sample.age),
      runtime.ops.prepare(`INSERT INTO audit_events (id, actor_kind, action, target_type, target_id, next_state, request_id, created_at)
        VALUES (?, 'system', 'intake.demo_seeded', 'consultation', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, sample.status, crypto.randomUUID(), now - sample.age),
    ]);
  }
  for (const [index, inquiry] of [
    { name: '정하늘 (예시)', type: 'partnership', message: '청년 리더십 교육 프로그램의 공동 운영을 제안하고 싶습니다.', status: 'new' },
    { name: '윤지수 (예시)', type: 'research', message: '강점 기반 리더십 관련 연구 자료와 협업 가능 여부를 문의합니다.', status: 'reviewing' },
  ].entries()) {
    const id = crypto.randomUUID();
    await runtime.ops.batch([
      runtime.ops.prepare(`INSERT INTO inquiries (id, receipt_number, idempotency_key, request_hash, inquiry_type, name, email,
        message, privacy_consent_version, privacy_consented_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, `I-DEMO-${String(index + 1).padStart(3, '0')}`, crypto.randomUUID(), 'b'.repeat(64), inquiry.type,
          inquiry.name, `contact${index + 1}@example.invalid`, inquiry.message, runtime.intakePrivacyVersion,
          now - 1800 - index * 3600, inquiry.status, now - 1800 - index * 3600, now - 1800 - index * 3600),
      runtime.ops.prepare(`INSERT INTO audit_events (id, actor_kind, action, target_type, target_id, next_state, request_id, created_at)
        VALUES (?, 'system', 'intake.demo_seeded', 'inquiry', ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), id, inquiry.status, crypto.randomUUID(), now),
    ]);
  }
}

async function requestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536)
      throw Object.assign(new Error("BODY_TOO_LARGE"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export async function startDemoServer({ port = 8788 } = {}) {
  let runtime;
  let origin;
  const server = createServer(async (request, response) => {
    try {
      if (!runtime) return sendJson(response, 503, { error: "DEMO_STARTING" });
      if (request.headers.host !== new URL(origin).host)
        return sendJson(response, 421, { error: "HOST_FORBIDDEN" });
      const url = new URL(request.url, origin);
      if (url.origin !== origin)
        return sendJson(response, 421, { error: "HOST_FORBIDDEN" });
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (FILES[url.pathname] && request.method === "GET") {
        const [name, mimeType] = FILES[url.pathname];
        const content = await readFile(
          new URL(`../demo/${name}`, import.meta.url),
        );
        response.writeHead(200, { "Content-Type": mimeType });
        return response.end(content);
      }
      if (url.pathname === "/demo/config" && request.method === "GET") {
        return sendJson(response, 200, {
          mode: "local-test",
          accounts: ACCOUNTS.map(({ key, label, role }) => ({
            key,
            label,
            role,
          })),
          demoAdminCode: DEMO_CODE,
          stage: 3,
        });
      }
      if (url.pathname === "/demo/credential" && request.method === "POST") {
        if (request.headers.origin !== origin)
          return sendJson(response, 403, { error: "ORIGIN_FORBIDDEN" });
        if (
          request.headers["content-type"]?.split(";")[0] !== "application/json"
        ) {
          return sendJson(response, 415, { error: "JSON_REQUIRED" });
        }
        let body;
        try {
          body = JSON.parse((await requestBody(request)).toString("utf8"));
        } catch (error) {
          if (error.status) throw error;
          return sendJson(response, 400, { error: "INVALID_JSON" });
        }
        const account = ACCOUNTS.find(
          (account) => account.key === body?.account,
        );
        if (
          !account ||
          typeof body.nonce !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.nonce)
        ) {
          return sendJson(response, 400, { error: "DEMO_ACCOUNT_INVALID" });
        }
        const credential = await runtime.issueCredential({
          subject: account.subject,
          email: `${account.key}@example.invalid`,
          nonce: body.nonce,
        });
        return sendJson(response, 200, { credential });
      }
      if (url.pathname === "/demo/state" && request.method === "GET") {
        const now = Math.floor(Date.now() / 1000);
        const [opsTables, publicTables, views, users, members, admins, audits] =
          await Promise.all([
            runtime.ops
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .first(),
            runtime.content
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .first(),
            runtime.content
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'view'",
              )
              .first(),
            runtime.ops.prepare("SELECT count(*) AS n FROM users").first(),
            runtime.ops
              .prepare(
                "SELECT count(*) AS n FROM sessions WHERE kind = 'member' AND revoked_at IS NULL AND expires_at > ?",
              )
              .bind(now)
              .first(),
            runtime.ops
              .prepare(
                "SELECT count(*) AS n FROM sessions WHERE kind = 'admin' AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ?",
              )
              .bind(now, now - 1800)
              .first(),
            runtime.ops
              .prepare("SELECT count(*) AS n FROM audit_events")
              .first(),
          ]);
        return sendJson(response, 200, {
          databases: 2,
          opsTables: opsTables.n,
          publicTables: publicTables.n,
          views: views.n,
          users: users.n,
          memberSessions: members.n,
          adminSessions: admins.n,
          auditEvents: audits.n,
        });
      }
      if (url.pathname.startsWith("/api/")) {
        const headers = new Headers();
        for (const name of [
          "origin",
          "content-type",
          "x-csrf-token",
          "sec-fetch-site",
          "idempotency-key",
        ]) {
          if (request.headers[name]) headers.set(name, request.headers[name]);
        }
        headers.set("CF-Connecting-IP", "127.0.0.1");
        // Cookies are scoped to a host rather than a port. Give the local demo
        // a separate namespace so it cannot replace the normal dev server's cookies.
        const cookies = (request.headers.cookie ?? "")
          .split(";")
          .map((value) => value.trim())
          .filter((value) => value.startsWith("mli_demo_"))
          .map((value) => value.replace(/^mli_demo_/, "mli_"));
        if (cookies.length) headers.set("Cookie", cookies.join("; "));
        const body = ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await requestBody(request);
        const result = await runtime.simulator.dispatchFetch(url.href, {
          method: request.method,
          headers,
          body: body?.length ? body : undefined,
        });
        for (const [name, value] of result.headers) {
          if (name.toLowerCase() !== "set-cookie")
            response.setHeader(name, value);
        }
        const outgoingCookies = result.headers
          .getSetCookie()
          .map((value) => value.replace(/^mli_/, "mli_demo_"));
        if (outgoingCookies.length)
          response.setHeader("Set-Cookie", outgoingCookies);
        response.writeHead(result.status);
        return response.end(Buffer.from(await result.arrayBuffer()));
      }
      return sendJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (!response.headersSent)
        sendJson(response, error.status ?? 503, {
          error: error.status ? error.message : "DEMO_UNAVAILABLE",
        });
      else response.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    runtime = await createLocalAuthRuntime({
      origin,
      adminCode: DEMO_CODE,
      adminSubjects: ["demo-operator"],
      intake: true,
    });
    await seed(runtime);
  } catch (error) {
    await new Promise((resolveClose) => server.close(resolveClose));
    await runtime?.dispose();
    throw error;
  }
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
      await runtime.dispose();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex < 0 ? 8788 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid local demo port");
  const demo = await startDemoServer({ port });
  console.log(`MLI backend demo ready at ${demo.origin}`);
  console.log(
    "Local test authentication with isolated D1 storage. Google account setup is required for real sign-in.",
  );
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await demo.close();
    process.exit(0);
  }
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
