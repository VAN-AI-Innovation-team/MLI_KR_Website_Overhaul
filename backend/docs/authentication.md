# MLI 백엔드 2단계 인증 연동

홈페이지 기획안 11-6의 회원 로그인·내 활동, 11-7의 허용 Google 계정과 추가 관리자 코드 요구사항을 구현했습니다.

## API

| 메서드와 경로 | 처리 | 인증 |
| --- | --- | --- |
| GET `/api/health` | 두 DB와 현재 3단계 스키마 확인 | 공개 |
| GET `/api/auth/config` | 클라이언트 ID·정책 버전·지원 언어와 설정 상태 | 공개 |
| POST `/api/auth/challenge` | 일회용 nonce·CSRF 토큰과 HttpOnly 로그인 쿠키 발급 | Origin |
| POST `/api/auth/google` | Google 서명 검증·가입·정책 재동의·회원 세션 교체 | 로그인 쿠키·nonce·CSRF·Origin |
| GET `/api/me` | 본인 프로필·CSRF 토큰·세션 만료시각 | 회원 세션 |
| PATCH `/api/me` | 본인 닉네임·선호 언어 수정 | 회원 세션·CSRF·Origin |
| GET `/api/me/posts` | 본인 게시물 목록 | 회원 세션 |
| GET `/api/me/comments` | 본인 댓글 목록 | 회원 세션 |
| POST `/api/admin/session` | 허용 계정·운영자 등록·추가 코드 확인 후 관리 세션 발급 | 최근 Google 회원 로그인·회원 CSRF·Origin |
| GET `/api/admin/session` | 현재 관리 권한·CSRF 토큰·만료시각 | 회원·관리 세션·현재 허용 목록·활성 역할 |
| POST `/api/auth/logout` | 회원·연결된 관리 세션 폐기와 쿠키 제거 | 현재 회원 CSRF·Origin |

변경 요청의 Origin은 `APP_ORIGIN`과 일치해야 합니다. GET 요청도 Origin이 있으면 검사하며 `Sec-Fetch-Site: cross-site`는 거부합니다. 운영 환경은 홈페이지와 `/api`를 같은 출처로 연결합니다. Vercel의 외부 rewrite를 사용할 수 있습니다. 브라우저 fetch에는 `credentials: 'same-origin'`을 사용합니다.

## 실제 Google 로그인 설정

1. Google Cloud에서 기관 프로젝트의 웹 애플리케이션용 OAuth 클라이언트 ID를 준비합니다. 승인된 JavaScript 원본에 실제 홈페이지 주소와 사용할 로컬 주소를 등록합니다.
2. `Copy-Item .dev.vars.example .dev.vars`로 로컬 설정 파일을 만듭니다. 기존 파일이 있다면 필요한 항목을 직접 추가합니다.
3. `GOOGLE_CLIENT_ID`에 `…apps.googleusercontent.com` 값을 넣습니다. `TERMS_VERSION`, `PRIVACY_VERSION`에는 운영자가 확정한 정책 버전을 넣습니다. 서버가 빈 버전을 임의로 채우지 않습니다.
4. 로컬 기본 주소는 `http://127.0.0.1:8787`입니다. `ALLOW_INSECURE_LOCAL_COOKIES=true`는 HTTP 루프백 개발 주소에서만 적용됩니다. 운영 환경에서는 `APP_ORIGIN`을 실제 HTTPS 주소로 지정하고 해당 옵션을 끕니다.
5. `npm.cmd run db:migrate:local`, `npm.cmd run dev`를 실행하고 `/api/auth/config`의 `configured`를 확인합니다.

`http://127.0.0.1:8787`에서는 간단한 `test` 로그인 페이지를 제공합니다. 설정이 유효하면 공식 Google 버튼을 표시하고 nonce를 포함한 callback credential을 위 API로 전달합니다. `npm.cmd run demo`의 포트 8788은 가짜 서명 키와 별도 쿠키·임시 DB를 사용하는 테스트 계정 전용 서버입니다. 실제 Google credential은 8787의 실제 Google 공개 키 검증 경로에서만 처리합니다.

Google ID 토큰 검증에는 공개 JWKS를 사용합니다. 클라이언트 secret은 이 로그인 방식에서 필요하지 않습니다. `.dev.vars`는 Git에서 제외합니다. 운영 비밀값은 기관 계정의 Worker 비밀 설정에서 관리합니다.

## 프런트엔드 처리 순서

1. `/api/auth/config`에서 공개 설정을 읽습니다. 설정이 없으면 503과 `AUTH_NOT_CONFIGURED`를 표시합니다.
2. 동일 출처에서 POST `/api/auth/challenge`를 호출합니다. 응답의 `nonce`를 Google Identity Services의 `google.accounts.id.initialize({ client_id, nonce, callback })`에 전달합니다. 응답의 `csrfToken`은 해당 로그인 요청 동안 메모리에 둡니다.
3. Google callback의 `credential`과 챌린지의 `csrfToken`을 JSON으로 POST `/api/auth/google`에 전달합니다. Google의 redirect POST 방식 대신 JavaScript callback을 사용하는 계약입니다.
4. 신규 회원 또는 정책 재동의가 필요하면 `CONSENT_REQUIRED`를 428로 반환합니다. 사용자가 닉네임·언어를 정하고 실제 정책을 읽고 동의한 뒤 `registration`을 포함해 다시 요청합니다. 챌린지 또는 토큰이 만료되면 2번부터 다시 시작합니다.

```json
{
  "credential": "Google callback에서 받은 ID 토큰",
  "csrfToken": "챌린지 응답의 토큰",
  "registration": {
    "nickname": "사용자가 정한 닉네임",
    "preferredLanguage": "ko",
    "consent": {
      "terms": true,
      "privacy": true,
      "termsVersion": "config가 반환한 현재 버전",
      "privacyVersion": "config가 반환한 현재 버전"
    }
  }
}
```

5. 성공하면 프로필·회원 CSRF 토큰·만료시각을 반환하고 서버가 HttpOnly 쿠키를 설정합니다. 회원 토큰과 Google credential을 브라우저 저장소에 보관하지 않습니다.
6. 새로고침 후 GET `/api/me`로 로그인 상태와 회원 CSRF 토큰을 읽습니다. 프로필 수정·관리자 진입·로그아웃 요청에는 이 값을 `X-CSRF-Token`으로 전달합니다.

프로필 PATCH는 `nickname`, `preferredLanguage`만 받습니다. `role`, `status`, `user_id` 같은 임의 필드는 거부합니다. 내 활동 목록은 서버 세션의 회원 ID를 사용하며 `limit` 기본 20·최대 100과 `offset` 0~10000만 허용합니다. 삭제된 글의 제목·본문과 비공개 원글 링크를 응답에서 제외합니다.

## 관리자 등록과 코드

1. 운영자가 Google 로그인을 완료해 검증된 회원으로 등록됩니다. 서버 DB의 `auth_identities.subject`로 대상을 확인합니다. 이메일만으로 권한을 등록하지 않습니다.
2. 로컬 개발 DB에서 `npm.cmd run admin:grant:local -- <verified-google-subject> <role>`을 실행합니다. 역할은 `admin`, `editor`, `moderator`, `consultant`입니다. 존재하는 활성 회원만 등록할 수 있습니다. 운영 DB의 권한 변경은 기관 계정에서 별도로 수행합니다.
3. `ADMIN_GOOGLE_SUBJECTS`에 허용할 Google subject를 쉼표로 구분해 설정합니다. DB 운영자 등록과 허용 목록을 모두 검사합니다.
4. 비밀번호 관리자로 32바이트 이상의 난수 코드를 생성해 보관합니다. 32~128자의 공백 없는 ASCII 코드를 받습니다. `npm.cmd run auth:hash-code`의 비표시 입력으로 SHA-256 검증값을 만든 뒤 `ADMIN_CODE_SHA256`에 설정합니다. 실제 코드는 Git·URL·정적 번들에 넣지 않습니다.
5. Google 로그인 후 10분 안에 회원 CSRF 헤더와 JSON `{"code":"입력한 관리자 코드"}`로 POST `/api/admin/session`을 호출합니다. 시간이 지났으면 Google 로그인을 다시 진행합니다.

| 역할 | 제공하는 권한 |
| --- | --- |
| admin | 콘텐츠 편집·발행, 조정, 상담 조회·처리, 감사 조회 |
| editor | 콘텐츠 편집·발행 |
| moderator | 게시물·댓글·신고 조정 |
| consultant | 상담 조회·처리 |

권한 목록은 서버 검사 함수 `requireAdmin(request, env, now, permission)`와 연결됩니다. 3단계 [상담·Contact 관리 API](intake.md)에서 목록·상세·변경·담당자·감사 권한을 검사합니다. 변경 요청에는 회원 CSRF가 아닌 관리자 세션이 발급한 CSRF를 사용합니다.

## 세션과 실패 처리

- 회원 세션은 최대 24시간입니다. 관리자 세션은 유휴 30분·최대 8시간이며 부모 회원 세션의 만료를 넘지 않습니다.
- 운영 쿠키는 `__Host-` 접두어, Secure, HttpOnly, SameSite=Lax, Path=/를 사용합니다. HTTP 루프백 개발 옵션을 켠 경우에만 `mli_` 이름을 사용합니다.
- DB에는 회원·관리 토큰의 SHA-256 해시만 저장합니다. Google 식별값은 검증된 `sub`이며 이메일이 바뀌어도 같은 회원을 찾습니다.
- 로그인 챌린지는 10분 유효하며 한 번만 사용할 수 있습니다. 가입·챌린지 소비·세션 발급·감사 기록은 같은 D1 배치에서 처리합니다.
- 로그인 시 기존 브라우저 세션을 교체하고 연결된 관리 세션도 폐기합니다. 로그아웃 시 DB에서 회원·연결된 관리 세션을 폐기합니다.
- 관리자 코드 시도는 IP·회원·세션 단위로 제한합니다. 5회 실패하면 15분 동안 추가 코드 검증을 차단합니다. 새 회원 세션으로 로그인해도 회원 단위 제한이 유지됩니다.
- 관리자 코드 검증값을 바꾸면 이전 검증값으로 발급한 관리 세션이 즉시 무효가 되며 다음 관리 요청에서 일괄 폐기됩니다. 역할·활성 여부·허용 subject도 요청마다 검사합니다.
- Google 키 서버나 DB 실패는 503, 미인증·만료는 401, 권한·CSRF·Origin 오류는 403, 과다 시도는 429로 응답합니다. 내부 SQL·토큰·코드를 응답과 로그에 기록하지 않습니다.

## 검증과 다음 연결

`npm.cmd test`는 테스트 전용 RSA 키로 서명한 토큰과 SQLite에서 잘못된 서명·발급자·대상·만료·nonce, 동의, 중복 로그인, 동시 가입, 본인 정보, 관리자 역할·코드·잠금·만료·폐기와 트랜잭션 실패를 검증합니다. 테스트 키는 기본 Worker의 실행 설정에서 주입할 수 없습니다. 실제 Google 계정 로그인과 홈페이지 연동은 기관 OAuth 설정과 승인 정책을 넣은 뒤 검수합니다.

`npm.cmd run test:runtime`은 빌드한 기본 Worker를 Miniflare와 격리된 로컬 D1에서 실행해 로그인·프로필 수정·내 활동 조회·관리자 역할·로그아웃을 검증합니다. 해당 테스트 프로세스의 외부 호출 처리기에서 Google JWKS 응답만 테스트 공개 키로 대체합니다. 일반 개발 서버와 운영 Worker는 Google의 고정 공개 키 URL을 사용합니다.

다음 연결 대상은 상담·Contact 접수, Turnstile, 관리자 신청함, 게시판 쓰기·수정·신고와 발행 처리입니다.

공식 근거

- [Google ID 토큰 서버 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Google JavaScript API와 nonce](https://developers.google.com/identity/gsi/web/reference/js-reference)
- [jose 서명·클레임 검증](https://github.com/panva/jose)
