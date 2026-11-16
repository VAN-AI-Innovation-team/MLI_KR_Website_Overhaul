const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  csrf: null,
  admin: null,
  account: "member",
  activity: "posts",
  config: null,
  busy: false,
  logs: [],
};
const messages = {
  SESSION_REQUIRED:
    "로그인이 필요한 요청입니다. 회원 로그인 후 다시 확인해 주세요.",
  SESSION_EXPIRED: "세션이 만료되었거나 로그아웃되었습니다.",
  ADMIN_AUTH_FAILED:
    "관리자 인증이 거부됐습니다. 운영자 계정과 올바른 코드가 모두 필요합니다.",
  ADMIN_FORBIDDEN: "현재 계정에 이 관리자 권한이 없습니다.",
  TOO_MANY_ATTEMPTS:
    "인증 시도가 제한됐습니다. 관리자 코드 오류 5회 후에는 15분간 대기합니다.",
  NICKNAME_INVALID: "닉네임을 1~40자로 입력해 주세요.",
  GOOGLE_REAUTH_REQUIRED:
    "관리자 진입을 위해 테스트 계정으로 다시 로그인해 주세요.",
};
const permissionNames = {
  "content:write": "콘텐츠 편집",
  "content:publish": "콘텐츠 발행",
  "moderation:write": "게시물·댓글 관리",
  "consultations:read": "상담 조회",
  "consultations:write": "상담 처리",
  "audit:read": "감사 기록 조회",
};

function notice(message, tone = "success") {
  $("feedback").textContent = message;
  $("feedback").dataset.tone = tone;
  $("feedback").hidden = false;
}

function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["csrfToken", "nonce", "credential"].includes(key))
      .map(([key, child]) => [key, sanitized(child)]),
  );
}

function selectResponse(entry) {
  $("response-method").textContent = entry.method;
  $("response-path").textContent = entry.path;
  $("response-status").textContent = entry.status;
  $("response-status").classList.toggle("error", entry.status >= 400);
  $("response-body").textContent = JSON.stringify(entry.body, null, 2);
  for (const [index, row] of [...$("request-log").children].entries()) {
    row.classList.toggle("selected", state.logs[index] === entry);
  }
}

function record(entry) {
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 7);
  $("request-log").replaceChildren();
  for (const item of state.logs) {
    const button = document.createElement("button");
    button.className = "request-row";
    button.type = "button";
    button.setAttribute(
      "aria-label",
      `${item.method} ${item.path} HTTP ${item.status}`,
    );
    for (const [text, className] of [
      [item.status, `log-status${item.status >= 400 ? " error" : ""}`],
      [item.method, "log-method"],
      [item.path, "log-path"],
      [`${item.duration}ms`, "log-duration"],
    ]) {
      const span = document.createElement("span");
      span.textContent = text;
      span.className = className;
      button.append(span);
    }
    button.addEventListener("click", () => selectResponse(item));
    $("request-log").append(button);
  }
  selectResponse(entry);
}

async function api(path, { method = "GET", body, csrf = state.csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
  const started = performance.now();
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  record({
    method,
    path,
    status: response.status,
    body: sanitized(data),
    duration: Math.round(performance.now() - started),
  });
  return { ok: response.ok, status: response.status, data };
}

function renderUser(user, expiresAt) {
  state.user = user;
  if (!user) state.admin = null;
  $("login-panel").hidden = Boolean(user);
  $("profile-panel").hidden = !user;
  $("logout-button").hidden = !user;
  $("session-badge").textContent = state.admin
    ? "관리자 인증됨"
    : user
      ? "회원 로그인됨"
      : "비로그인";
  $("session-badge").classList.toggle("authenticated", Boolean(user));
  if (user) {
    $("member-name").textContent = user.nickname;
    $("member-avatar").textContent = Array.from(user.nickname)[0] ?? "M";
    $("nickname").value = user.nickname;
    $("language").value = user.preferredLanguage;
    if (expiresAt)
      $("expires-at").textContent = new Date(expiresAt * 1000).toLocaleString(
        "ko-KR",
      );
  }
  renderAdmin();
}

function renderAdmin() {
  const authenticated = Boolean(state.admin);
  $("admin-status").textContent = authenticated ? "관리자 인증됨" : "인증 대기";
  $("admin-status").classList.toggle("authenticated", authenticated);
  $("admin-description").textContent = authenticated
    ? "서버에서 운영자 계정·추가 코드·관리자 세션을 확인했습니다."
    : "운영자 계정으로 로그인한 뒤 추가 코드를 확인합니다.";
  $("permissions").replaceChildren();
  $("permissions").hidden = !authenticated;
  if (authenticated)
    for (const permission of state.admin.permissions) {
      const span = document.createElement("span");
      span.textContent = permissionNames[permission] ?? permission;
      $("permissions").append(span);
    }
  for (const id of ["admin-code", "fill-code", "admin-submit", "wrong-code"])
    $(id).disabled = !state.user || state.busy;
  $("session-badge").textContent = authenticated
    ? "관리자 인증됨"
    : state.user
      ? "회원 로그인됨"
      : "비로그인";
}

async function refreshDatabase() {
  const response = await fetch("/demo/state", { cache: "no-store" });
  if (!response.ok) throw new Error("시연 DB 상태를 읽지 못했습니다.");
  const data = await response.json();
  for (const [id, key] of [
    ["db-count", "databases"],
    ["member-count", "memberSessions"],
    ["admin-count", "adminSessions"],
    ["ops-tables", "opsTables"],
    ["public-tables", "publicTables"],
    ["user-count", "users"],
    ["audit-count", "auditEvents"],
    ["view-count", "views"],
  ])
    $(id).textContent = data[key];
}

async function loadActivity() {
  $("posts-tab").classList.toggle("active", state.activity === "posts");
  $("comments-tab").classList.toggle("active", state.activity === "comments");
  $("posts-tab").setAttribute(
    "aria-pressed",
    String(state.activity === "posts"),
  );
  $("comments-tab").setAttribute(
    "aria-pressed",
    String(state.activity === "comments"),
  );
  $("activity-list").replaceChildren();
  if (!state.user) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "로그인하면 본인이 작성한 활동이 표시됩니다.";
    $("activity-list").append(message);
    return;
  }
  const result = await api(`/api/me/${state.activity}`);
  if (!result.ok)
    return notice(messages[result.data.error] ?? result.data.error, "error");
  for (const item of result.data.items) {
    const row = document.createElement("div");
    row.className = "activity-item";
    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = state.activity === "posts" ? "▤" : "↳";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.title ?? item.body ?? "삭제된 활동";
    const details = document.createElement("small");
    details.textContent = `본인 작성 · ${new Date(item.created_at * 1000).toLocaleDateString("ko-KR")}`;
    content.append(title, details);
    const status = document.createElement("span");
    status.className = "item-state";
    status.textContent =
      { published: "공개", hidden: "숨김", deleted: "삭제" }[item.status] ??
      item.status;
    row.append(icon, content, status);
    $("activity-list").append(row);
  }
  if (!result.data.items.length) {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "이 계정으로 작성한 활동이 없습니다.";
    $("activity-list").append(message);
  }
}

async function action(run) {
  if (state.busy) return;
  state.busy = true;
  for (const option of document.querySelectorAll("[data-account]"))
    option.disabled = true;
  for (const id of [
    "login-button",
    "logout-button",
    "save-profile",
    "reload-profile",
    "probe-button",
  ])
    $(id).disabled = true;
  renderAdmin();
  try {
    await run();
    await refreshDatabase();
  } catch {
    notice(
      "서버에 연결하지 못했습니다. 시연 서버의 실행 상태를 확인해 주세요.",
      "error",
    );
  } finally {
    state.busy = false;
    for (const option of document.querySelectorAll("[data-account]"))
      option.disabled = false;
    for (const id of [
      "login-button",
      "logout-button",
      "save-profile",
      "reload-profile",
      "probe-button",
    ])
      $(id).disabled = false;
    renderAdmin();
  }
}

for (const button of document.querySelectorAll("[data-account]")) {
  button.addEventListener("click", () => {
    state.account = button.dataset.account;
    for (const option of document.querySelectorAll("[data-account]")) {
      const active = option === button;
      option.classList.toggle("active", active);
      option.setAttribute("aria-pressed", String(active));
    }
  });
}

$("login-button").addEventListener("click", () =>
  action(async () => {
    const challenge = await api("/api/auth/challenge", { method: "POST" });
    if (!challenge.ok) return notice(challenge.data.error, "error");
    const tokenResponse = await fetch("/demo/credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: state.account,
        nonce: challenge.data.nonce,
      }),
    });
    if (!tokenResponse.ok) throw new Error("Unable to issue demo credential");
    const { credential } = await tokenResponse.json();
    const result = await api("/api/auth/google", {
      method: "POST",
      body: { credential, csrfToken: challenge.data.csrfToken },
    });
    if (!result.ok)
      return notice(messages[result.data.error] ?? result.data.error, "error");
    state.csrf = result.data.csrfToken;
    state.admin = null;
    renderUser(result.data.user, result.data.expiresAt);
    await loadActivity();
    notice(
      `${result.data.user.nickname} 계정으로 로그인했습니다. 회원 세션이 DB에 저장됐습니다.`,
    );
  }),
);

$("profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    const result = await api("/api/me", {
      method: "PATCH",
      body: {
        nickname: $("nickname").value,
        preferredLanguage: $("language").value,
      },
    });
    if (!result.ok)
      return notice(messages[result.data.error] ?? result.data.error, "error");
    renderUser(result.data.user);
    notice(
      "프로필을 DB에 저장했습니다. 다시 조회하거나 새로고침해도 유지됩니다.",
    );
  });
});

$("reload-profile").addEventListener("click", () =>
  action(async () => {
    const result = await api("/api/me");
    if (!result.ok)
      return notice(messages[result.data.error] ?? result.data.error, "error");
    state.csrf = result.data.csrfToken;
    renderUser(result.data.user, result.data.expiresAt);
    notice("서버에 저장된 본인 정보를 다시 불러왔습니다.");
  }),
);

$("probe-button").addEventListener("click", () =>
  action(async () => {
    const result = await api("/api/me");
    notice(
      result.ok
        ? "HTTP 200 · 유효한 회원 세션으로 본인 정보를 조회했습니다."
        : `HTTP ${result.status} · ${messages[result.data.error] ?? result.data.error}`,
      result.ok ? "success" : "info",
    );
  }),
);

$("fill-code").addEventListener("click", () => {
  $("admin-code").value = state.config.demoAdminCode;
});

async function authorizeAdmin(code) {
  const result = await api("/api/admin/session", {
    method: "POST",
    body: { code },
  });
  if (!result.ok)
    return notice(
      `HTTP ${result.status} · ${messages[result.data.error] ?? result.data.error}`,
      "error",
    );
  const checked = await api("/api/admin/session");
  if (!checked.ok)
    return notice(messages[checked.data.error] ?? checked.data.error, "error");
  state.admin = checked.data;
  renderAdmin();
  notice(
    "관리자 인증에 성공했습니다. 현재 역할과 허용된 권한을 서버에서 확인했습니다.",
  );
}

$("admin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(() => authorizeAdmin($("admin-code").value));
});
$("wrong-code").addEventListener("click", () =>
  action(() => authorizeAdmin("DEMO-WRONG-ADMIN-CODE-LOCAL-ONLY-123456")),
);

$("logout-button").addEventListener("click", () =>
  action(async () => {
    const result = await api("/api/auth/logout", { method: "POST" });
    if (!result.ok)
      return notice(messages[result.data.error] ?? result.data.error, "error");
    state.csrf = null;
    renderUser(null);
    $("admin-code").value = "";
    await loadActivity();
    const probe = await api("/api/me");
    notice(
      `로그아웃했습니다. 이후 본인 정보 조회가 HTTP ${probe.status}로 차단됐습니다.`,
    );
  }),
);

for (const kind of ["posts", "comments"])
  $(kind === "posts" ? "posts-tab" : "comments-tab").addEventListener(
    "click",
    () => {
      state.activity = kind;
      action(loadActivity);
    },
  );

async function initialize() {
  const configResponse = await fetch("/demo/config", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("Demo configuration unavailable");
  state.config = await configResponse.json();
  const health = await api("/api/health");
  if (!health.ok) throw new Error("Backend unavailable");
  $("health-status").textContent = `정상 · ${health.data.stage}단계`;
  $("server-label").textContent = "로컬 서버 연결됨";
  $("server-dot").classList.add("ready");
  await refreshDatabase();
  const existing = await api("/api/me");
  if (existing.ok) {
    state.csrf = existing.data.csrfToken;
    renderUser(existing.data.user, existing.data.expiresAt);
    const admin = await api("/api/admin/session");
    if (admin.ok) {
      state.admin = admin.data;
      renderAdmin();
    }
    await loadActivity();
  } else {
    renderUser(null);
    selectResponse(state.logs.find((entry) => entry.path === "/api/health"));
  }
}

initialize().catch(() => {
  $("health-status").textContent = "연결 확인 필요";
  $("server-label").textContent = "서버 연결 확인 필요";
  notice(
    "시연 서버에 연결하지 못했습니다. npm run demo로 실행한 뒤 다시 열어 주세요.",
    "error",
  );
});
