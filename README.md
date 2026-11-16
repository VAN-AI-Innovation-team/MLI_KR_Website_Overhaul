# MLI_KR_Website_Overhaul

MLI 한국지부 홈페이지 개편 프로젝트입니다.

## 백엔드 통합 · 1·2단계

`backend/`에 Cloudflare Workers·D1 기반의 DB 구조와 Google 로그인·서버 세션·회원 소유권·관리자 인증을 구현했습니다. 업무용 원본 DB와 공개 콘텐츠 DB, SQL 마이그레이션, 상태 확인 API와 자동 테스트를 포함합니다.

백엔드 누적 작업 브랜치는 `namuking1/mli-backend-step1`입니다. 이 브랜치에 1단계 DB 기반과 2단계 인증 구현이 함께 포함되며, 후속 작업도 같은 브랜치에 커밋해서 반영합니다.

- [백엔드 설치와 실행](backend/README.md)
- [테이블 구조와 구현 규칙](backend/docs/database.md)
- [Google 로그인·회원·관리자 연동](backend/docs/authentication.md)

Node.js 24 이상에서 DB와 자동 테스트를 로컬로 실행할 수 있습니다. 실제 Google 로그인에는 웹용 OAuth 클라이언트 ID와 확정한 정책 버전을 설정합니다. 상담 제출·게시판 쓰기·발행 API는 이후 단계에서 연결합니다.

```powershell
git clone --branch namuking1/mli-backend-step1 https://github.com/VAN-AI-Innovation-team/MLI_KR_Website_Overhaul.git
cd MLI_KR_Website_Overhaul/backend
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev
```

macOS·Linux에서는 `npm.cmd` 대신 `npm`을 사용합니다.
