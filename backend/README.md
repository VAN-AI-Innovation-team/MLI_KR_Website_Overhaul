# MLI 백엔드 통합 · 1·2·3단계

MLI 한국지부 홈페이지 기획안의 DB 기반에 Google 로그인, 서버 세션, 회원 본인 정보·활동 조회, 관리자 인증과 상담·Contact 접수·관리 API를 연결했습니다. 회원·상담·게시물의 원본을 보관하는 `mli-ops`와 공개용 복사본을 보관하는 `mli-content`를 분리했습니다.

1단계 DB 구조, 2단계 인증과 3단계 접수는 같은 `backend/` 프로젝트에서 실행합니다. 2단계 인증 마이그레이션에 이어 `0006_intake_protection.sql`을 추가해 접수 토큰 재사용을 막습니다. 기존 로컬 DB도 `npm.cmd run db:migrate:local`로 기존 데이터를 유지하며 추가 구조를 적용할 수 있습니다.

현재 구현 범위는 DB 구조·마이그레이션, 상태 확인 API, Google ID 토큰 검증, 회원 가입·로그인·로그아웃, 프로필 조회·수정, 본인 게시글·댓글 조회, 관리자 허용 계정·코드·세션 검사, 비회원 상담·Contact 접수와 관리자 신청함 API입니다. 3단계에는 Turnstile 서버 검증·속도 제한·중복 접수 방지·상태 전이·담당자 배정·일정·내부 메모·감사 기록을 포함합니다. 상담·신청함 프런트엔드, 게시판 CRUD, CMS 발행·동기화, AI 호출과 외부 배포는 이후 작업입니다.

2단계 API와 Google 설정, 관리자 등록 방법은 [인증 연동 가이드](docs/authentication.md)에 정리했습니다. 실제 Google 로그인에는 기관의 웹용 OAuth 클라이언트 ID와 확정한 약관·개인정보 처리방침 버전이 필요합니다. 설정 전에는 상태 확인 API와 자동 테스트를 사용할 수 있습니다.

3단계 API와 입력·동의·Turnstile 설정, 상태 전이·관리 권한은 [상담·Contact 연동 가이드](docs/intake.md)를 확인합니다. 비회원 접수는 Google OAuth와 별개로 동작하며 `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `INTAKE_PRIVACY_VERSION`이 필요합니다. 선택 마케팅 동의와 보유 일수는 확정한 정책이 있을 때만 설정합니다.

## 로컬 데모

`backend` 폴더에서 아래 명령을 실행합니다.

```powershell
npm.cmd ci
npm.cmd run demo
```

3단계는 [상담·문의 데모](http://127.0.0.1:8788/stage3)를 엽니다. 예시 내용을 채워 접수하고, **관리자 신청함 → 테스트 운영자로 입장**에서 원문 조회와 상태·담당자·메모 변경을 확인할 수 있습니다.

2단계는 [로그인 데모](http://127.0.0.1:8788)를 엽니다. `test 계정으로 로그인`을 누르면 로그인 성공 화면과 회원 닉네임이 표시됩니다. `로그인 상태 확인`은 서버의 세션을 다시 조회하고, `로그아웃`은 세션을 종료합니다. 새로고침해도 로그인 상태가 유지됩니다.

이 화면은 **로컬 테스트 인증**입니다. 테스트 계정·RSA 서명 키·Google 공개 키 응답만 시연용으로 구성하고, 회원·권한·세션 처리는 빌드한 실제 Worker와 별도의 임시 D1을 사용합니다. 실제 Google 계정 로그인은 OAuth 설정 후 연결해야 합니다. 시연은 `127.0.0.1`에서만 열리며, 기존 로컬 DB·환경 변수와 분리되고 서버를 다시 시작하면 초기화됩니다. 브라우저 쿠키도 `mli_demo_` 접두사로 분리합니다.

`demo/`의 간단한 로그인 페이지는 Wrangler 정적 파일로도 제공합니다. `scripts/demo.mjs`의 테스트 계정 발급 도구는 Worker 배포에 포함되지 않습니다. `npm.cmd run test:demo`는 테스트 서버의 로그인·프로필 저장·본인 활동 조회·관리자 권한·로그아웃과 쿠키 분리를 검증합니다.

### 실제 Google 로그인 test

`npm.cmd run dev`를 실행하고 [Google 로그인 test](http://127.0.0.1:8787)을 엽니다. `demo/`의 동일한 페이지가 실제 Worker API를 사용합니다. Google Cloud의 웹 애플리케이션 클라이언트에 승인된 JavaScript 원본 `http://127.0.0.1:8787`을 등록하고, `.dev.vars`의 `GOOGLE_CLIENT_ID`와 정책 버전을 설정해야 합니다. JavaScript callback 방식이므로 redirect URI나 클라이언트 secret은 사용하지 않습니다. 설정 전에는 Google 버튼을 비활성 상태로 표시합니다.

Google Identity Services의 공식 버튼을 사용하며, 서버가 발급한 nonce와 로그인 CSRF 값을 전달합니다. 처음 가입하거나 정책 버전이 변경된 사용자는 닉네임과 두 동의 항목을 직접 확인해야 합니다. 토큰과 credential은 메모리에만 유지하며 브라우저 저장소에 보관하지 않습니다. `test` 화면의 이용·개인정보 안내는 로컬 기능 검증을 위한 내용이며, 기관 정식 서비스에서는 확정한 정책과 프런트엔드로 교체해야 합니다. 로컬 정책 버전을 사용하는 경우 `test-terms-v1`, `test-privacy-v1`처럼 정식 정책과 구분합니다.

## 1단계를 진행하는 순서

1. **저장할 정보를 정합니다.** 회원에는 닉네임과 약관 동의 기록, 상담에는 연락처·내용·희망 시간·처리 상태를 저장합니다.
2. **공개할 정보와 비공개 정보를 나눕니다.** 상담 원문과 Google 식별값은 `mli-ops`에만 둡니다. 공개 게시물은 필요한 필드만 골라 `mli-content`로 옮기는 구조입니다.
3. **테이블 사이의 관계를 정합니다.** 글의 작성자는 존재하는 회원이어야 하고, 상담 담당자는 등록된 운영자여야 합니다. 외래 키로 이 관계를 검사합니다.
4. **잘못된 저장을 막는 규칙을 둡니다.** 동의 기록 없는 상담, 중복 접수 키, 일정 없는 예약 확정 등을 DB에서 거부합니다. 로그인·작성 권한은 이후 서버 코드에서도 별도로 확인해야 합니다.
5. **SQL 마이그레이션으로 DB를 만듭니다.** 마이그레이션은 테이블 구조 변경을 순서대로 기록하는 파일입니다. 적용한 파일은 다시 실행하지 않습니다.
6. **저장·실패 상황을 검증합니다.** 테스트 DB에서 정상 입력과 잘못된 입력을 확인하고, 실제 로컬 D1에도 마이그레이션을 적용합니다.

## 실행

Node.js 24 이상이 필요합니다. Windows PowerShell 기준으로 아래 명령을 실행합니다. `npm.cmd`는 PowerShell의 `npm.ps1` 실행 정책 문제를 피합니다.

```powershell
git clone --branch namuking1/mli-backend-step1 https://github.com/VAN-AI-Innovation-team/MLI_KR_Website_Overhaul.git
cd MLI_KR_Website_Overhaul/backend
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run db:inspect:local
npm.cmd run dev
```

로컬 실행에는 Cloudflare 로그인이나 실제 D1 ID가 필요하지 않습니다. 설정 파일의 두 UUID는 로컬 개발용 자리표시자입니다. 데이터는 이 프로젝트의 `.wrangler/state/`에 저장됩니다.

통합 작업 브랜치는 `namuking1/mli-backend-step1`입니다. 1·2·3단계 구현과 후속 변경을 이 브랜치에 누적합니다. 이미 저장소를 내려받았다면 해당 브랜치로 전환하고 최신 커밋을 받은 뒤 `backend` 폴더에서 실행합니다. macOS와 Linux에서는 `npm.cmd` 대신 `npm`, `npx.cmd` 대신 `npx`를 사용합니다.

서버 실행 후 브라우저에서 `http://127.0.0.1:8787/api/health`를 엽니다.

```json
{"status":"ok","stage":3}
```

이 응답은 두 DB와 3단계 접수 보호·기존 인증 테이블에 접근할 수 있음을 뜻합니다. 마이그레이션을 적용하지 않았거나 DB가 실패하면 개인정보나 내부 오류를 포함하지 않은 503 응답을 반환합니다. `/api/auth/config`에서 Google 인증 설정 상태를, `/api/intake/config`에서 접수 설정 상태를 확인할 수 있습니다.

검증 명령은 다음과 같습니다.

```powershell
npm.cmd test
npm.cmd run test:runtime
npm.cmd run test:demo
npm.cmd run check
```

`test`는 일회용 SQLite DB와 테스트 외부 응답으로 DB·인증·접수·중복·권한·상태 전이·동시 수정·감사 롤백을 검증합니다. `test:runtime`은 빌드한 기본 Worker와 격리된 실제 로컬 D1에서 로그인부터 접수·신청함·로그아웃까지 검증합니다. 테스트 프로세스에서 Google·Turnstile 외부 응답만 대체합니다. `test:demo`는 기존 로그인 데모를 검사합니다. `check`는 테스트 후 Wrangler의 배포 파일 생성 검사(`--dry-run`)를 수행합니다. D1 마이그레이션 적용은 `db:migrate:local`로 확인합니다.

## 파일 읽는 순서

| 파일 | 역할 |
| --- | --- |
| `docs/database.md` | 테이블 분류, 관계, 상태, 다음 단계에서 지켜야 할 규칙 |
| `docs/authentication.md` | 2단계 API, Google·쿠키·관리자 설정과 연동 순서 |
| `docs/intake.md` | 3단계 접수·Turnstile·중복·관리자 처리 API 계약 |
| `migrations/ops/0001_identity.sql` | 회원, Google 계정 연결, 운영자, 세션 |
| `migrations/ops/0002_intake.sql` | 상담, Contact, 감사 기록 |
| `migrations/ops/0003_editorial.sql` | 게시판, 번역, 댓글, 신고, AI 검수 원본, 발행 작업 |
| `migrations/ops/0004_authentication.sql` | 일회용 로그인 챌린지, 시도 제한, 관리자 세션 연결 |
| `migrations/ops/0006_intake_protection.sql` | 접수 토큰 재사용 방지와 문의 유형 색인 |
| `migrations/content/0001_public_content.sql` | 공개 게시물, 승인 지식, 사이트 안내 경로 |
| `wrangler.jsonc` | Worker와 D1 두 개의 연결 설정 |
| `src/worker.js` | API 라우팅, 상태·인증·회원·관리자 세션 API |
| `src/google.js`, `src/auth.js` | Google 서명 검증, 세션, 관리자 권한·시도 제한 |
| `src/intake.js`, `src/turnstile.js` | 접수 입력·동의·중복·서버 검증·원자적 저장 |
| `src/intake-admin.js` | 신청함 조회·변경·일정·배정·감사 |
| `tests/auth.test.js` | 서명·소유권·재전송·만료·동시 가입·코드 교체 검증 |
| `tests/schema.test.js` | DB 관계·동의·중복·공개 분리 검증 |
| `tests/intake.test.js` | 접수·권한·전이·경쟁·감사 롤백·기존 DB 업그레이드 |

## 운영 DB로 옮길 때

로컬 작업을 마친 뒤 실제 기관 계정에서 DB를 생성할 때 사용하는 명령입니다. 아래 원격 작업은 이번 구현에서 실행하지 않았습니다.

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create mli-content
npx.cmd wrangler d1 create mli-ops
```

각 명령이 반환한 실제 `database_id`를 `wrangler.jsonc`의 해당 DB 자리표시자와 바꿉니다. 테스트용 원격 DB와 운영 DB는 별도 설정·이름·ID로 분리합니다. 이후 대상 계정과 ID를 확인하고 적용합니다.

```powershell
npx.cmd wrangler d1 migrations apply mli-content --remote
npx.cmd wrangler d1 migrations apply mli-ops --remote
```

실제 배포 주소·Vercel rewrite와 운영 인증·Turnstile·정식 동의 정책은 프런트엔드 연결 단계에서 설정합니다. 현재 `workers_dev`는 `false`이고 원격 배포 명령은 실행하지 않았습니다.

## 이후 개발 순서

1. 실제 Google OAuth·Turnstile·정식 정책·운영자 설정과 로그인·상담·Contact·관리자 신청함 프런트엔드 연결
2. 게시판·댓글·신고 API, 공식 콘텐츠 검수·발행, 공개 DB 동기화
3. 승인 자료 검색과 AI 연결, 사용량 차단, 백업·복원·보유 기간에 따른 파기

유료 AI, 자동 이메일, 대용량 첨부 기능은 기본 설정에서 꺼져 있으며 해당 호출 코드는 없습니다. 인증·접수 검증은 Google 공개 키와 Turnstile Siteverify를 사용합니다. 보유 기간과 공식 동의 문구는 운영자가 확정한 정책을 서버 설정과 프런트엔드에 연결해야 합니다.

## 공식 기술 근거

- [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 로컬 개발](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 외래 키](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [Turnstile 서버 검증](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
