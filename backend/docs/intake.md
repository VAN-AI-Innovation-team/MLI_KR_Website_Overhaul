# MLI 백엔드 3단계 · 상담·Contact와 관리자 신청함

비회원 상담·문의 접수, Turnstile 서버 검증, 중복 접수 방지와 관리자 처리 API를 구현했습니다. 개인정보는 `OPS_DB`에만 저장하며 접수번호로 원문을 조회하는 공개 API는 제공하지 않습니다. 접수 성공은 상담 예약 확정을 뜻하지 않습니다.

## API

| 메서드와 경로 | 처리 | 필요한 권한 |
| --- | --- | --- |
| GET `/api/intake/config` | 공개 site key, 현재 동의 버전, 언어·action | 공개 |
| POST `/api/consultations` | 상담 접수 | 같은 출처·Turnstile·개인정보 동의 |
| POST `/api/inquiries` | Contact 접수 | 같은 출처·Turnstile·개인정보 동의 |
| GET `/api/admin/consultations` | 상담 목록·필터·페이지 | `consultations:read` |
| GET `/api/admin/consultations/:id` | 상담 상세·조회 감사 기록 | `consultations:read` |
| PATCH `/api/admin/consultations/:id` | 상태·담당자·내부 메모·일정 변경 | `consultations:write`·관리자 CSRF |
| GET `/api/admin/inquiries` | 문의 목록·필터·페이지 | `consultations:read` |
| GET `/api/admin/inquiries/:id` | 문의 상세·조회 감사 기록 | `consultations:read` |
| PATCH `/api/admin/inquiries/:id` | 문의 상태·담당자·내부 메모 변경 | `consultations:write`·관리자 CSRF |
| GET `/api/admin/intake-assignees` | 배정 가능한 활성 운영자 | `consultations:read` |
| GET `/api/admin/audit-events` | 접수·조회·변경 감사 기록 | `audit:read` |

기존 권한명 `consultations:*`는 상담과 Contact 신청함에 함께 적용합니다. `admin`과 `consultant`가 신청함을 처리하며, 감사 조회는 `admin`만 가능합니다. `editor`, `moderator`, 일반 회원은 신청함을 조회할 수 없습니다. [2단계 인증](authentication.md)의 회원 세션, 허용 Google subject, 활성 운영자 역할, 추가 코드와 관리자 세션을 모두 검사합니다.

변경 요청은 `Origin: APP_ORIGIN`이 필수입니다. GET도 Origin이 있으면 검사하고, `Sec-Fetch-Site: cross-site`는 거부합니다. 요청·응답은 JSON이며 모든 응답에 `Cache-Control: no-store`를 설정합니다. 접수는 최대 64 KiB, 로그인 요청은 기존 16 KiB 제한을 유지합니다. 사용자 입력은 일반 텍스트로 저장하므로 프런트엔드에서는 `textContent` 등으로 표시합니다.

## 설정과 실행

기존 `.dev.vars`를 덮어쓰지 말고 `.dev.vars.example`의 아래 항목을 추가합니다.

| 환경변수 | 값 |
| --- | --- |
| `APP_ORIGIN` | 홈페이지와 API가 사용하는 출처. 운영은 HTTPS |
| `TURNSTILE_SITE_KEY` | 해당 홈페이지용 widget 공개 키 |
| `TURNSTILE_SECRET_KEY` | 서버 전용 widget secret |
| `INTAKE_PRIVACY_VERSION` | 운영자가 확정한 상담·문의 개인정보 동의 버전 |
| `MARKETING_CONSENT_VERSION` | 선택 동의 버전. 빈 값이면 마케팅 수신 동의를 받지 않음 |
| `INTAKE_RETENTION_DAYS` | 확정한 보유 일수 1~36500. 비워두면 `retention_until = NULL` |

접수 설정은 회원 로그인용 `PRIVACY_VERSION`과 별개입니다. 비회원 접수에는 Google OAuth 설정이 필요하지 않습니다. 관리자는 기존 Google 로그인·정책·운영자 설정이 필요합니다. 공개 설정 응답에 secret이나 운영자 목록을 포함하지 않습니다. 필수 설정이 없으면 503으로 접수를 거부합니다. 보유 기간은 정책을 대신 결정하지 않으며, 자동 파기 스케줄러는 후속 범위입니다.

```powershell
cd MLI_KR_Website_Overhaul/backend
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev
```

기존 1·2단계 DB에는 `0006_intake_protection.sql`이 추가 적용됩니다. 기존 회원·세션·접수 데이터는 보존합니다. GET `/api/health`가 `{"status":"ok","stage":3}`을 반환하면 새 보호 테이블까지 접근 가능한 상태입니다. 이는 실제 Turnstile 키나 정식 정책 설정이 완료되었다는 뜻은 아닙니다.

## 프런트엔드 접수 계약

1. GET `/api/intake/config`에서 `configured`, `siteKey`, `privacyVersion`, `marketingVersion`, `actions`를 읽습니다. 정책 본문은 기관에서 확정한 안내를 표시합니다.
2. Turnstile widget을 상담 `action: 'consultation'`, 문의 `action: 'inquiry'`로 생성합니다. 사용자가 실제 정책을 읽고 선택한 동의만 전달합니다.
3. 새 신청마다 `crypto.randomUUID()`로 `Idempotency-Key`를 만들고 아래 JSON을 전송합니다. 키는 접수 결과를 확인할 때까지 같은 신청에 유지합니다. 개인정보와 토큰을 URL에 넣지 않습니다.
4. 201을 받은 뒤에만 접수번호를 표시합니다. 네트워크가 끊겨 결과를 받지 못했다면 같은 키·같은 입력으로 재시도합니다. 처리 완료된 요청은 200과 원래 번호를 반환합니다. 이 재확인은 원래 동의 버전과 희망 일정이 만료된 뒤에도 가능합니다.
5. 새 요청의 Turnstile 실패·만료 시 widget을 초기화해 새 토큰을 받습니다. 입력을 수정했다면 새 접수 키를 사용합니다. 같은 키에 다른 내용을 보내면 409입니다. 접수 키를 아는 것만으로 원문이나 관리자 처리 상태를 조회할 수 없습니다.

```javascript
const response = await fetch('/api/consultations', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey },
  body: JSON.stringify({
    name: '신청자가 입력한 이름',
    email: 'applicant@example.com',
    consultationType: 'individual',
    topic: '상담 내용',
    preferredLanguage: 'ko',
    preferredTimezone: 'Asia/Seoul',
    preferredMode: 'online',
    consent: { privacy: true, privacyVersion: config.privacyVersion },
    turnstileToken,
  }),
});
```

새 접수 응답 예시:

```json
{"receiptNumber":"C-20261120-0123456789ABCDEF","receivedAt":1795132800,"replayed":false}
```

응답은 접수번호·서버 접수시각·재확인 여부만 포함합니다. `status`, `version`, `confirmedTime`, `assignedAdminId`, 보유 기간이나 동의시각을 클라이언트가 접수 시 지정할 수 없습니다.

| 입력 | 허용값·제한 |
| --- | --- |
| 공통 `name`, `email` | 이름 1~100자, 이메일 최대 254자·형식 검사 |
| 공통 `preferredLanguage` | `ko` 기본값, `en`, `zh-CN`, `es`, `fr`, `ja` |
| 상담 `consultationType` | `individual`, `organization`, `other` |
| 상담 `topic` | 1~5000자 |
| 상담 선택 필드 | `phone` 최대 40자, `organization` 200자, `jobTitle` 100자 |
| 상담 `preferredTime1`, `preferredTime2` | 선택 UTC Unix 초 정수. 새 접수 시 미래 시각 |
| 상담 `preferredTimezone`, `preferredMode` | 유효한 시간대·기본 `Asia/Seoul`, 방식 `online` 또는 `offline` |
| 문의 `inquiryType` | `general`, `press`, `research`, `partnership`, `site_issue` |
| 문의 `message` | 1~5000자 |
| 공통 `consent` | `privacy: true`, 현재 `privacyVersion` 필수 |
| 상담 선택 마케팅 동의 | 선택 시 `marketing: true`, 현재 `marketingVersion`. 미선택은 버전 없이 생략 또는 `marketing: false` |
| `turnstileToken` | 최대 2048자. 해시만 일시 보관 |

문자열을 NFC·앞뒤 공백·줄바꿈 기준으로 정규화해 해시를 계산합니다. 접수 테이블별 키는 16~128자의 영문·숫자·`_`·`-`를 받으며 UUID를 권장합니다. 본문과 동의 버전을 해시에 포함하고 Turnstile 토큰·서버 시각·보유 기간은 제외합니다.

## Turnstile·속도 제한·원자적 저장

서버는 고정된 Cloudflare Siteverify 주소에 요청하고 `success`, `hostname === APP_ORIGIN의 hostname`, 위의 `action`, 최근 300초 내 challenge 시각을 검사합니다. 호출 제한시간은 5초이며 리다이렉트를 따라가지 않습니다. 장애·잘못된 secret은 503, 검증 실패는 403으로 반환하고 접수를 저장하지 않습니다. 이 흐름은 [Cloudflare 서버 검증 문서](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)를 기준으로 구현했습니다.

Cloudflare 토큰 재사용 감지는 전파 지연 중 동시에 성공할 수 있으므로 `intake_token_redemptions`의 UNIQUE 해시로 애플리케이션에서도 한 번만 허용합니다. 접수 원문, 토큰 해시 사용 기록, 접수 감사 이벤트는 하나의 `OPS_DB.batch()`에서 저장됩니다. 어느 하나라도 실패하면 모두 롤백합니다. 경쟁 요청의 같은 키·같은 본문은 기존 접수번호로 정리합니다. 해시 사용 기록은 10분 후 정리 대상이 되며 성공 접수 시 만료 기록을 최대 100건씩 정리합니다.

상담과 문의에 공통으로 IP당 10분 20회, 이메일당 1시간 5회 시도 제한을 적용합니다. 같은 키의 접수 재확인은 IP 제한을 적용하지만 이메일 제한과 Siteverify를 다시 소모하지 않습니다. 차단 시 429와 `Retry-After`를 반환합니다. `CF-Connecting-IP`만 사용하고 없으면 로컬 공통 버킷을 사용합니다. `X-Forwarded-For`는 신뢰하지 않습니다. 속도 제한 식별값은 기존 `auth_rate_limits`에 `intake:*` 범위의 SHA-256 해시로 보관합니다.

## 관리자 목록과 변경

관리자 진입은 [2단계 가이드](authentication.md)를 따릅니다. PATCH의 `X-CSRF-Token`에는 `/api/admin/session`이 반환한 **관리자 CSRF**를 넣습니다. 회원 CSRF를 대신 넣으면 거부합니다.

목록 쿼리는 `status`, `type`, `assignedAdminId`(운영자 UUID 또는 `unassigned`), `limit`(기본 20·최대 100), `offset`(기본 0·최대 10000)만 허용합니다. 중복·알 수 없는 쿼리는 거부합니다. 목록에는 번호·유형·신청자 이름·상태·담당자·후속 시각·버전·처리시각을 반환하며, 연락처와 원문·메모는 상세에서만 반환합니다. 정렬은 `createdAt DESC, id DESC`이고 필터 적용 전체 건수 `total`을 함께 제공합니다.

모든 PATCH는 상세 또는 목록에서 읽은 현재 `version`과 하나 이상의 변경 필드를 포함해야 합니다.

```json
{
  "version": 1,
  "status": "reviewing",
  "assignedAdminId": "배정할 운영자의 UUID",
  "internalNote": "운영자 내부 메모",
  "followUpAt": 1795219200
}
```

담당자는 허용 Google subject에 포함된 활성 회원·활성 운영자 중 `admin` 또는 `consultant`만 가능합니다. `/api/admin/intake-assignees`에서 선택할 수 있으며 `null`로 배정을 해제합니다. `internalNote`는 최대 10000자이고 빈 문자열로 지웁니다. `followUpAt`은 미래 Unix 초 또는 `null`입니다. 원문·연락처·동의 증빙은 이 API에서 수정하지 않습니다.

| 상담 현재 상태 | 허용하는 다음 상태 |
| --- | --- |
| `new` | `reviewing`, `cancelled` |
| `reviewing` | `needs_info`, `proposed`, `cancelled` |
| `needs_info` | `reviewing`, `cancelled` |
| `proposed` | `reviewing`, `needs_info`, `confirmed`, `cancelled` |
| `confirmed` | `proposed`, `completed`, `cancelled` |
| `completed`, `cancelled` | 상태 전이 없음 |

| 문의 현재 상태 | 허용하는 다음 상태 |
| --- | --- |
| `new` | `reviewing`, `cancelled` |
| `reviewing` | `needs_info`, `completed`, `cancelled` |
| `needs_info` | `reviewing`, `completed`, `cancelled` |
| `completed`, `cancelled` | 상태 전이 없음 |

같은 상태를 유지하며 메모·담당자·후속 시각을 수정할 수 있습니다. 상담을 `confirmed`로 바꿀 때는 미래의 `confirmedTime`이 필요합니다. 확정 후 메모만 수정할 때 기존 일정이 과거여도 허용합니다. 확정을 취소해 `proposed` 등으로 돌아가면 확정 일정을 지우고, `completed`로 바꾸면 실제 확정 일정을 보존합니다. 문의에는 `confirmedTime` 필드가 없습니다.

변경은 `WHERE id = ? AND version = ?` 조건으로 저장하고 버전을 1 올립니다. 다른 운영자가 먼저 변경했다면 409 `VERSION_CONFLICT`를 반환하므로 최신 상세를 다시 읽고 판단해야 합니다. 변경과 감사 이벤트를 같은 배치에 저장하며, 경쟁에서 진 요청에는 감사 이벤트를 추가하지 않습니다. 상세 조회 역시 `intake.viewed` 감사를 저장할 수 있어야 원문을 반환합니다.

감사에는 작업자 UUID, 대상 UUID·종류, 행동, 상태 전후, 서버 요청 UUID와 시각만 기록합니다. 원문·연락처·내부 메모·토큰은 넣지 않습니다. `/api/admin/audit-events`는 상담·문의 이벤트만 반환하며 `targetType`, `targetId`, `limit`, `offset`으로 좁힐 수 있습니다.

## 오류와 검증

| HTTP | 주요 코드·처리 |
| --- | --- |
| 400 | `INVALID_*`, `IDEMPOTENCY_KEY_REQUIRED`, `TURNSTILE_TOKEN_REQUIRED`, 잘못된 일정·배정 |
| 401 | 로그인·관리자 세션 필요 또는 만료 |
| 403 | `ORIGIN_FORBIDDEN`, `CSRF_INVALID`, `ADMIN_FORBIDDEN`, `TURNSTILE_INVALID`, `TURNSTILE_REUSED` |
| 404 | `INTAKE_NOT_FOUND` 또는 없는 경로 |
| 405 | 허용하지 않는 메서드. `Allow` 헤더 제공 |
| 409 | `IDEMPOTENCY_CONFLICT`, `VERSION_CONFLICT`, `INVALID_STATUS_TRANSITION` |
| 413 / 415 | 요청이 너무 크거나 JSON이 아님 |
| 428 | 현재 개인정보·마케팅 정책에 명시적 동의 필요 |
| 429 | 속도 제한. `Retry-After` 참고 |
| 503 | 설정 없음, 검증 서비스 장애 또는 DB·감사 저장 실패 |

```powershell
npm.cmd test
npm.cmd run test:runtime
npm.cmd run test:demo
npm.cmd run check
```

자동 테스트는 입력·동의·중복·토큰 재사용·권한·전이·경쟁 수정·감사 롤백·기존 DB 업그레이드를 검사합니다. `test:runtime`은 기본 Worker를 빌드한 뒤 격리된 실제 로컬 D1에서 Google 서명 로그인부터 접수·신청함·경쟁 수정·감사 실패 롤백·로그아웃까지 확인합니다. 이때 Google과 Turnstile의 외부 응답만 테스트 프로세스가 대체하며 Worker에는 우회 환경변수나 테스트 로그인 경로를 추가하지 않습니다.

실제 widget 연동은 기관용 site key·secret과 허용 hostname에서 별도로 확인해야 합니다. Cloudflare의 [공식 테스트 키](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)는 hostname을 `example.com`으로 반환하며 action을 생략하므로 이 API의 엄격한 hostname·action 검사에는 그대로 사용할 수 없습니다. 테스트를 위해 운영 검사를 끄는 옵션은 제공하지 않습니다.

`backend`에서 `npm.cmd run demo`를 실행한 뒤 [3단계 로컬 화면](http://127.0.0.1:8788/stage3)을 엽니다. 예시 상담·문의를 접수하고 테스트 운영자로 입장해 신청함을 확인할 수 있습니다. 데모는 서버 재시작 시 초기화되는 임시 D1을 사용합니다. 운영 프런트 연동과 원격 DB 적용은 별도 단계입니다.
