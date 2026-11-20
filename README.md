# MLI_KR_Website_Overhaul

MLI 한국지부 홈페이지 개편 프로젝트입니다.

## 백엔드 통합 · 1·2·3단계

`backend/`에 Cloudflare Workers·D1 기반의 DB 구조, Google 로그인·서버 세션·회원 소유권·관리자 인증, 비회원 상담·Contact 접수와 관리자 신청함 API를 구현했습니다. Turnstile 서버 검증, 중복 접수 방지, 상태·담당자·일정 변경과 감사 기록을 포함합니다.

백엔드 누적 작업 브랜치는 `namuking1/mli-backend-step1`입니다. 1단계 DB 기반, 2단계 인증과 3단계 접수 API를 같은 `backend/`에서 관리합니다.

- [백엔드 설치와 실행](backend/README.md)
- [테이블 구조와 구현 규칙](backend/docs/database.md)
- [Google 로그인·회원·관리자 연동](backend/docs/authentication.md)
- [3단계 상담·Contact 접수와 관리자 신청함](backend/docs/intake.md)

Node.js 24 이상에서 DB와 자동 테스트를 로컬로 실행할 수 있습니다. `backend`에서 `npm.cmd run demo`를 실행하면 [3단계 로컬 화면](http://127.0.0.1:8788/stage3)을 볼 수 있습니다. 운영 서비스는 Google OAuth, Turnstile, 확정한 동의 정책을 설정하고 홈페이지 프런트와 연결합니다.

```powershell
git clone --branch namuking1/mli-backend-step1 https://github.com/VAN-AI-Innovation-team/MLI_KR_Website_Overhaul.git
cd MLI_KR_Website_Overhaul/backend
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev
```

macOS·Linux에서는 `npm.cmd` 대신 `npm`을 사용합니다.
