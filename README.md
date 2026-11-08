# MLI_KR_Website_Overhaul

MLI 한국지부 홈페이지 개편 프로젝트입니다.

## 백엔드 1단계

`backend/`에 Cloudflare Workers·D1 기반의 DB 설계를 구성했습니다. 업무용 원본 DB와 공개 콘텐츠 DB, SQL 마이그레이션, 연결 상태 API, 데이터 무결성 테스트를 포함합니다.

- [백엔드 설치와 실행](backend/README.md)
- [테이블 구조와 구현 규칙](backend/docs/database.md)

Node.js 24 이상에서 로컬로 실행할 수 있으며, 이 단계에는 Cloudflare 계정이나 API 키가 필요하지 않습니다. 로그인·상담 제출·발행 API는 이후 단계에서 연결합니다.

```powershell
cd backend
npm.cmd ci
npm.cmd run db:migrate:local
npm.cmd run dev
```

macOS·Linux에서는 `npm.cmd` 대신 `npm`을 사용합니다.
