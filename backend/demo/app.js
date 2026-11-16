const $ = (id) => document.getElementById(id);
let csrf = null;

function message(text, error = false) {
  $("message").textContent = text;
  $("message").dataset.error = String(error);
  $("message").hidden = !text;
}

function render(user) {
  $("login-panel").hidden = Boolean(user);
  $("member-panel").hidden = !user;
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
    throw new Error("요청을 완료하지 못했습니다. 다시 시도해 주세요.");
  return result.data;
}

async function action(work) {
  const buttons = [$("login-button"), $("check-button"), $("logout-button")];
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    await work();
  } catch (error) {
    message(error.message || "서버에 연결하지 못했습니다.", true);
  } finally {
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

$("login-button").addEventListener("click", () =>
  action(async () => {
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

$("check-button").addEventListener("click", () =>
  action(async () => {
    const user = await currentUser();
    message(
      user ? "로그인 상태가 확인되었습니다." : "로그인이 필요합니다.",
      !user,
    );
  }),
);

$("logout-button").addEventListener("click", () =>
  action(async () => {
    requireSuccess(await request("/api/auth/logout", { method: "POST" }));
    const user = await currentUser();
    if (user) throw new Error("로그아웃 상태를 다시 확인해 주세요.");
    message("로그아웃되었습니다.");
  }),
);

action(async () => {
  await currentUser();
});
