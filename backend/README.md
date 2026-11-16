# MLI 백엔드 통합 · 1·2단계

MLI 한국지부 홈페이지 기획안의 DB 기반에 Google 로그인, 서버 세션, 회원 본인 정보·활동 조회와 관리자 인증을 연결했습니다. 회원·상담·게시물의 원본을 보관하는 `mli-ops`와 공개용 복사본을 보관하는 `mli-content`를 분리했습니다.

1단계 DB 구조와 2단계 인증은 같은 `backend/` 프로젝트에서 실행합니다. 1단계 SQL 위에 `0004_authentication.sql`과 `0005_auth_session_indexes.sql`을 적용해 기존 회원·운영자·세션 테이블과 인증 API를 연결했습니다. 기존 로컬 DB도 `npm.cmd run db:migrate:local`로 추가 구조를 적용할 수 있습니다.

현재 구현 범위는 DB 구조·마이그레이션, 상태 확인 API, Google ID 토큰 검증, 회원 가입·로그인·로그아웃, 프로필 조회·수정, 본인 게시글·댓글 조회, 관리자 허용 계정·코드·세션 검사입니다. 상담 제출, 게시판 CRUD, CMS 발행·동기화, AI 호출은 이후 단계에서 연결합니다. 프런트엔드 연결과 외부 배포는 이후 작업입니다.

2단계 API와 Google 설정, 관리자 등록 방법은 [인증 연동 가이드](docs/authentication.md)에 정리했습니다. 실제 Google 로그인에는 기관의 웹용 OAuth 클라이언트 ID와 확정한 약관·개인정보 처리방침 버전이 필요합니다. 설정 전에는 상태 확인 API와 자동 테스트를 사용할 수 있습니다.

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

통합 작업 브랜치는 `namuking1/mli-backend-step1`입니다. 1·2단계 구현과 후속 변경을 이 브랜치에 누적합니다. 이미 저장소를 내려받았다면 해당 브랜치로 전환하고 최신 커밋을 받은 뒤 `backend` 폴더에서 실행합니다. macOS와 Linux에서는 `npm.cmd` 대신 `npm`, `npx.cmd` 대신 `npx`를 사용합니다.

서버 실행 후 브라우저에서 `http://127.0.0.1:8787/api/health`를 엽니다.

```json
{"status":"ok","stage":2}
```

이 응답은 두 DB와 2단계 인증 테이블·세션 필드에 접근할 수 있음을 뜻합니다. 마이그레이션을 적용하지 않았거나 DB가 실패하면 개인정보나 내부 오류를 포함하지 않은 503 응답을 반환합니다. `/api/auth/config`에서 Google 인증 설정 상태를 확인할 수 있습니다.

검증 명령은 다음과 같습니다.

```powershell
npm.cmd test
npm.cmd run test:runtime
npm.cmd run check
```

`test`는 일회용 메모리 SQLite DB, 로컬 RSA 서명 토큰과 테스트 공개 키로 DB 규칙과 인증 처리 경로를 검증합니다. `test:runtime`은 빌드한 기본 Worker와 격리된 실제 로컬 D1에서 로그인·프로필·관리자·로그아웃을 검증합니다. 테스트 프로세스에서 Google 공개 키 응답만 테스트 키로 대체합니다. `check`는 테스트 후 Wrangler의 배포 파일 생성 검사(`--dry-run`)를 수행합니다. D1 마이그레이션 적용은 `db:migrate:local`로 확인합니다.

## 파일 읽는 순서

| 파일 | 역할 |
| --- | --- |
| `docs/database.md` | 테이블 분류, 관계, 상태, 다음 단계에서 지켜야 할 규칙 |
| `docs/authentication.md` | 2단계 API, Google·쿠키·관리자 설정과 연동 순서 |
| `migrations/ops/0001_identity.sql` | 회원, Google 계정 연결, 운영자, 세션 |
| `migrations/ops/0002_intake.sql` | 상담, Contact, 감사 기록 |
| `migrations/ops/0003_editorial.sql` | 게시판, 번역, 댓글, 신고, AI 검수 원본, 발행 작업 |
| `migrations/ops/0004_authentication.sql` | 일회용 로그인 챌린지, 시도 제한, 관리자 세션 연결 |
| `migrations/content/0001_public_content.sql` | 공개 게시물, 승인 지식, 사이트 안내 경로 |
| `wrangler.jsonc` | Worker와 D1 두 개의 연결 설정 |
| `src/worker.js` | API 라우팅, 상태·인증·회원·관리자 세션 API |
| `src/google.js`, `src/auth.js` | Google 서명 검증, 세션, 관리자 권한·시도 제한 |
| `tests/auth.test.js` | 서명·소유권·재전송·만료·동시 가입·코드 교체 검증 |
| `tests/schema.test.js` | DB 관계·동의·중복·공개 분리 검증 |

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

로그인과 권한 검사가 완성되기 전에는 개인정보를 받는 운영 API를 공개하지 않습니다. 실제 배포 주소·Vercel rewrite는 프런트엔드 연결 단계에서 설정합니다. 현재 `workers_dev`는 `false`이고 배포 명령은 실행하지 않았습니다.

## 이후 개발 순서

1. 실제 Google OAuth·약관 버전·운영자 설정과 프런트엔드 로그인 연결
2. 상담·Contact 제출 API, Turnstile 서버 검증, 관리자 신청함 API
3. 게시판·댓글·신고 API, 공식 콘텐츠 검수·발행, 공개 DB 동기화
4. 승인 자료 검색과 AI 연결, 사용량 차단, 백업·복원

유료 AI, 자동 이메일, 대용량 첨부 기능은 기본 설정에서 꺼져 있습니다. 실제 외부 호출 코드는 아직 없습니다. 보유 기간과 공식 동의 문구는 운영자가 확정한 정책을 다음 단계의 서버 설정에 연결해야 합니다.

## 공식 기술 근거

- [D1 마이그레이션](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 로컬 개발](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [D1 외래 키](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
