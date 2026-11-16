import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { sha256 } from "../src/http.js";

// Node-only local tooling. This module is outside the Worker entry point and
// never reads .dev.vars, operational credentials, or persistent D1 storage.
export async function createLocalAuthRuntime({
  origin,
  adminCode,
  adminSubjects,
}) {
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "local-test-key",
    alg: "RS256",
  };
  const clientId = "local-test.apps.googleusercontent.com";
  const policies = {
    termsVersion: "local-test-terms-v1",
    privacyVersion: "local-test-privacy-v1",
  };
  const simulator = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(
        new URL("../.build/worker.js", import.meta.url),
      ),
      compatibilityDate: "2026-11-08",
      bindings: {
        APP_ORIGIN: origin,
        ALLOW_INSECURE_LOCAL_COOKIES: "true",
        GOOGLE_CLIENT_ID: clientId,
        TERMS_VERSION: policies.termsVersion,
        PRIVACY_VERSION: policies.privacyVersion,
        ADMIN_GOOGLE_SUBJECTS: adminSubjects.join(","),
        ADMIN_CODE_SHA256: await sha256(adminCode),
      },
      d1Databases: {
        OPS_DB: "isolated-local-auth-ops",
        CONTENT_DB: "isolated-local-auth-content",
      },
      outboundService: async (request) => {
        if (request.url !== "https://www.googleapis.com/oauth2/v3/certs") {
          throw new Error("Unexpected network request from local test runtime");
        }
        return Response.json(
          { keys: [jwk] },
          { headers: { "Cache-Control": "public, max-age=3600" } },
        );
      },
    }),
  );
  try {
    const ops = await simulator.getD1Database("OPS_DB");
    const content = await simulator.getD1Database("CONTENT_DB");
    for (const [kind, db] of [
      ["ops", ops],
      ["content", content],
    ]) {
      const directory = new URL(`../migrations/${kind}/`, import.meta.url);
      for (const name of readdirSync(directory)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        const sql = readFileSync(new URL(name, directory), "utf8").replace(
          /--[^\r\n]*/g,
          "",
        );
        const statements = sql
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean);
        await db.batch(statements.map((statement) => db.prepare(statement)));
      }
    }
    return {
      simulator,
      ops,
      content,
      clientId,
      policies,
      async issueCredential({ subject, email, nonce }) {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({
          iss: "https://accounts.google.com",
          aud: clientId,
          sub: subject,
          email,
          email_verified: true,
          nonce,
          iat: now,
          exp: now + 600,
        })
          .setProtectedHeader({ alg: "RS256", kid: "local-test-key" })
          .sign(keys.privateKey);
      },
      dispose: () => simulator.dispose(),
    };
  } catch (error) {
    await simulator.dispose();
    throw error;
  }
}
