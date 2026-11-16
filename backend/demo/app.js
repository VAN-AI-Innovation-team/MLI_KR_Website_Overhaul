const $ = (id) => document.getElementById(id);
let csrf = null;
let testMode = false;
let settings = null;
let pendingLogin = null;
let googleTimer = null;
let busy = false;

const errors = {
  AUTH_NOT_CONFIGURED: "Google 로그인 설정이 필요합니다.",
  GOOGLE_TOKEN_INVALID:
    "Google 인증을 확인하지 못했습니다. 다시 시작해 주세요.",
  LOGIN_CHALLENGE_INVALID: "로그인 시간이 만료됐습니다. 다시 시작해 주세요.",
  GOOGLE_NONCE_INVALID: "Google 인증을 다시 시작해 주세요.",
  NICKNAME_INVALID: "닉네임을 1~40자로 입력해 주세요.",
  TOO_MANY_ATTEMPTS: "잠시 후 다시 시도해 주세요.",
};

function message(text, error = false) {
  $("message").textContent = text;
  $("message").dataset.error = String(error);
  $("message").hidden = !text;
}

function render(user) {
  $("login-panel").hidden = Boolean(user);
  $("member-panel").hidden = !user;
  $("registration-panel").hidden = true;
  $("member-name").textContent = user?.nickname ?? "";
  if (!user) csrf = null;
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    data: await response.json(),
  };
}

function requireSuccess(result) {
  if (!result.ok)
    throw new Error(
      errors[result.data.error] ??
        "요청을 완료하지 못했습니다. 다시 시작해 주세요.",
    );
  return result.data;
}

async function action(work) {
  if (busy) return;
  busy = true;
  const buttons = [
    $("login-button"),
    $("check-button"),
    $("logout-button"),
    $("register-button"),
    $("cancel-button"),
  ];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  $("google-button").inert = true;
  try {
    await work();
  } catch (error) {
    message(error.message || "서버에 연결하지 못했습니다.", true);
    if (!testMode) $("restart-button").hidden = false;
  } finally {
    busy = false;
    $("google-button").inert = false;
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

async function currentUser() {
  const result = await request("/api/me");
  if (result.status === 401) {
    render(null);
    return null;
  }
  const data = requireSuccess(result);
  csrf = data.csrfToken;
  render(data.user);
  return data.user;
}

function loadGoogleSdk() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(
      () =>
        reject(
          new Error("Google 연결이 지연되고 있습니다. 다시 시작해 주세요."),
        ),
      15000,
    );
    script.src = "https://accounts.google.com/gsi/client?hl=ko";
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Google 로그인 화면을 불러오지 못했습니다."));
    };
    document.head.append(script);
  });
}

async function finishGoogleLogin(registration) {
  if (!pendingLogin) throw new Error("Google 로그인을 다시 시작해 주세요.");
  const result = await request("/api/auth/google", {
    method: "POST",
    body: { ...pendingLogin, ...(registration ? { registration } : {}) },
  });
  if (result.status === 428 && result.data.error === "CONSENT_REQUIRED") {
    $("login-panel").hidden = true;
    $("registration-panel").hidden = false;
    $("nickname").focus();
    message("닉네임과 동의 항목을 확인해 주세요.");
    return;
  }
  const data = requireSuccess(result);
  pendingLogin = null;
  clearTimeout(googleTimer);
  csrf = data.csrfToken;
  if (!(await currentUser()))
    throw new Error("로그인 상태를 확인하지 못했습니다.");
  message("Google 로그인에 성공했습니다.");
}

async function prepareGoogle() {
  await loadGoogleSdk();
  const challenge = requireSuccess(
    await request("/api/auth/challenge", { method: "POST" }),
  );
  window.google.accounts.id.initialize({
    client_id: settings.clientId,
    nonce: challenge.nonce,
    ux_mode: "popup",
    auto_select: false,
    callback: (response) => {
      if (busy || typeof response.credential !== "string") return;
      pendingLogin = {
        credential: response.credential,
        csrfToken: challenge.csrfToken,
      };
      action(() => finishGoogleLogin());
    },
  });
  $("google-placeholder").hidden = true;
  window.google.accounts.id.renderButton($("google-button"), {
    theme: "outline",
    size: "large",
    text: "signin_with",
    locale: "ko",
    width: Math.max(200, Math.min(300, $("login-panel").clientWidth)),
  });
  $("setup-note").textContent = "Google 계정을 선택해 로그인하세요.";
  googleTimer = setTimeout(
    () => {
      pendingLogin = null;
      $("google-button").replaceChildren();
      $("registration-panel").hidden = true;
      $("login-panel").hidden = false;
      $("restart-button").hidden = false;
      message("로그인 시간이 만료됐습니다. 다시 시작해 주세요.", true);
    },
    Math.max(1, challenge.expiresIn - 5) * 1000,
  );
}

$("login-button").addEventListener("click", () =>
  action(async () => {
    if (!testMode) return;
    message("로그인 중입니다…");
    const challenge = requireSuccess(
      await request("/api/auth/challenge", { method: "POST" }),
    );
    const credential = requireSuccess(
      await request("/demo/credential", {
        method: "POST",
        body: { account: "member", nonce: challenge.nonce },
      }),
    );
    const login = requireSuccess(
      await request("/api/auth/google", {
        method: "POST",
        body: {
          credential: credential.credential,
          csrfToken: challenge.csrfToken,
        },
      }),
    );
    csrf = login.csrfToken;
    if (!(await currentUser()))
      throw new Error("로그인 상태를 확인하지 못했습니다.");
    message("로그인에 성공했습니다.");
  }),
);

$("registration-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("registration-form").reportValidity()) return;
  action(() =>
    finishGoogleLogin({
      nickname: $("nickname").value,
      preferredLanguage: "ko",
      consent: {
        terms: $("terms-consent").checked,
        privacy: $("privacy-consent").checked,
        termsVersion: settings.termsVersion,
        privacyVersion: settings.privacyVersion,
      },
    }),
  );
});

$("check-button").addEventListener("click", () =>
  action(async () => {
    const user = await currentUser();
    message(
      user ? "로그인 상태가 확인되었습니다." : "로그인이 필요합니다.",
      !user,
    );
    if (!user && !testMode) $("restart-button").hidden = false;
  }),
);

$("logout-button").addEventListener("click", () =>
  action(async () => {
    requireSuccess(await request("/api/auth/logout", { method: "POST" }));
    const user = await currentUser();
    if (user) throw new Error("로그아웃 상태를 다시 확인해 주세요.");
    if (!testMode) {
      window.google?.accounts?.id.disableAutoSelect();
      location.reload();
      return;
    }
    message("로그아웃되었습니다.");
  }),
);

for (const id of ["restart-button", "cancel-button"]) {
  $(id).addEventListener("click", () => {
    pendingLogin = null;
    location.reload();
  });
}

action(async () => {
  const modeResponse = await fetch("/demo/config", { cache: "no-store" });
  if (modeResponse.ok)
    testMode = (await modeResponse.json()).mode === "local-test";
  $("test-panel").hidden = !testMode;
  if (testMode) {
    $("google-placeholder").hidden = true;
    $("google-link").hidden = false;
    $("setup-note").textContent =
      "실제 Google 계정 로그인은 위 링크에서 확인합니다.";
    await currentUser();
    return;
  }
  const config = await request("/api/auth/config");
  if (!config.ok || !config.data.configured) {
    $("setup-note").textContent =
      "Google OAuth 클라이언트 ID 설정이 필요합니다.";
    return;
  }
  settings = config.data;
  if (!(await currentUser())) await prepareGoogle();
});
