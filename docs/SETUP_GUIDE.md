# 환경 설정 가이드 (Setup Guide)

이 문서는 Malgn Chatbot 프로젝트의 개발 환경을 설정하는 방법을 단계별로 설명합니다.

---

## 목차

1. [사전 준비](#1-사전-준비)
2. [Cloudflare 계정 설정](#2-cloudflare-계정-설정)
3. [프로젝트 클론](#3-프로젝트-클론)
4. [Backend 설정](#4-backend-설정)
5. [Frontend 설정](#5-frontend-설정)
6. [로컬 개발 실행](#6-로컬-개발-실행)
7. [멀티테넌트 배포](#7-멀티테넌트-배포)
8. [새 테넌트 추가](#8-새-테넌트-추가)
9. [문제 해결](#9-문제-해결)

---

## 1. 사전 준비

### 필수 설치 항목

| 도구 | 최소 버전 | 설치 확인 명령어 |
|------|----------|-----------------|
| Node.js | 18.0.0 | `node --version` |
| npm | 9.0.0 | `npm --version` |
| Git | 2.0.0 | `git --version` |

### Node.js 설치 (macOS)

```bash
# Homebrew로 설치
brew install node

# 또는 nvm으로 설치 (권장)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

### Node.js 설치 (Windows)

[Node.js 공식 사이트](https://nodejs.org/)에서 LTS 버전 다운로드

---

## 2. Cloudflare 계정 설정

### 2.1 Cloudflare 가입

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) 접속
2. 회원가입 (무료)
3. 이메일 인증

### 2.2 Wrangler CLI 설치 및 로그인

```bash
# Wrangler 전역 설치
npm install -g wrangler

# Cloudflare 로그인 (브라우저가 열림)
wrangler login

# 로그인 확인
wrangler whoami
```

---

## 3. 프로젝트 클론

```bash
# 프로젝트 폴더로 이동
cd ~/Projects

# Backend 클론
git clone <your-repo-url> malgn-chatbot-api

# Frontend 클론
git clone <your-repo-url> malgn-chatbot

# 테넌트별 프론트엔드 (선택)
git clone <your-repo-url> malgn-chatbot-user1
git clone <your-repo-url> malgn-chatbot-cloud
```

---

## 4. Backend 설정

### 4.1 의존성 설치

```bash
cd ~/Projects/malgn-chatbot-api
npm install
```

**설치되는 주요 패키지**:
- `hono` — 웹 프레임워크
- `@hono/swagger-ui` — Swagger UI 통합
- `jose` — JWT 처리 (선택적)
- `pdf-parse` — PDF 파싱
- `unpdf` — PDF 텍스트 추출

### 4.2 wrangler.toml 확인

`wrangler.toml` 파일에 이미 멀티테넌트 설정이 되어 있습니다.

```toml
name = "malgn-chatbot-api"
main = "src/index.js"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "development"
TENANT_ID = "dev"

[ai]
binding = "AI"
gateway = { id = "malgn-chatbot", cache_ttl = 3600 }

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-config-id"
# Hyperdrive는 Aurora MySQL connection string을 풀링/가속

[[kv_namespaces]]
binding = "KV"
id = "your-kv-id"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "malgn-chatbot-files"

[[vectorize]]
binding = "VECTORIZE"
index_name = "malgn-chatbot-vectors"
```

### 4.3 Cloudflare 리소스 생성 (신규 환경)

기존 리소스를 사용하지 않는 경우에만 실행합니다.

```bash
# Aurora MySQL 인스턴스 생성 (AWS 콘솔 또는 CLI)
# - AWS RDS Aurora MySQL 호환 클러스터를 생성하고 엔드포인트/계정 메모

# Hyperdrive 구성 생성 (위에서 만든 MySQL connection string 사용)
wrangler hyperdrive create malgn-chatbot-hyperdrive \
  --connection-string="mysql://<USER>:<PASSWORD>@<HOST>:3306/<DATABASE>"
# → id 메모 (wrangler.toml [[hyperdrive]] id에 입력)

# Vectorize 인덱스 생성 (1024차원, 코사인 유사도)
wrangler vectorize create malgn-chatbot-vectors --dimensions=1024 --metric=cosine

# KV 네임스페이스 생성
wrangler kv namespace create malgn-chatbot-kv
# → id 메모

# R2 버킷 생성
wrangler r2 bucket create malgn-chatbot-files
```

메모한 ID를 `wrangler.toml`에 입력합니다.

### 4.4 DB 스키마 적용 (Aurora MySQL)

```bash
# 전체 스키마 적용 (신규 DB)
mysql -h <HOST> -u <USER> -p <DATABASE> < schema.mysql.sql

# 개별 마이그레이션 (기존 DB 업데이트 시)
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/001_quiz_content_based.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/002_session_course_fields.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/003_session_parent_id.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/004_content_lesson_id.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/005_session_quiz_difficulty.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/005_session_quiz_split.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/006_quiz_session_id.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/006_session_generation_status.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/007_session_chat_content_ids.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/008_add_site_id.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/009_ai_log.sql
mysql -h <HOST> -u <USER> -p <DATABASE> < migrations/010_ai_log_lesson_id.sql
```

### 4.5 환경 변수 설정

`.dev.vars` 파일을 생성합니다 (Git에 커밋하지 마세요):

```bash
# .dev.vars 생성
cat > .dev.vars << 'EOF'
API_KEY=your-dev-api-key-here
EOF
```

프로덕션 시크릿 설정:

```bash
# 테넌트별 API Key 설정
wrangler secret put API_KEY --env user1
wrangler secret put API_KEY --env cloud
```

---

## 5. Frontend 설정

### 5.1 의존성 설치

```bash
cd ~/Projects/malgn-chatbot
npm install
```

### 5.2 임베드 위젯 빌드

```bash
# ES6 모듈 → IIFE 번들링
npm run build
# 결과: js/embed/*.js → js/chatbot-embed.js
```

### 5.3 프론트엔드 구조

```
malgn-chatbot/
├── index.html          # 관리자 대시보드
├── package.json        # esbuild 빌드 설정
├── css/
│   ├── style.css       # 대시보드 스타일
│   └── chatbot.css     # 임베드 위젯 스타일
├── js/
│   ├── app.js          # 메인 오케스트레이터
│   ├── api.js          # API 클라이언트
│   ├── chat.js         # 채팅 UI
│   ├── contents.js     # 콘텐츠 관리
│   ├── sessions.js     # 세션 관리
│   ├── settings.js     # AI 설정
│   ├── tenants.js      # 테넌트 전환
│   ├── chatbot-embed.js # 빌드된 임베드 위젯
│   └── embed/          # 위젯 소스 (ES6)
└── docs/               # 문서
```

---

## 6. 로컬 개발 실행

### Backend 실행

```bash
cd ~/Projects/malgn-chatbot-api

# 개발 서버 실행
npm run dev

# 출력:
# ⎔ Starting local server...
# Ready on http://localhost:8787
```

**테스트:**
```bash
# 헬스체크 (인증 불필요)
curl http://localhost:8787/health

# Swagger UI 확인
open http://localhost:8787/docs

# API 호출 테스트 (인증 필요)
curl -H "Authorization: Bearer your-dev-api-key-here" \
  http://localhost:8787/contents
```

### Frontend 실행

```bash
cd ~/Projects/malgn-chatbot

# Pages 개발 서버 실행
npx wrangler pages dev . --port 8788

# 브라우저에서 http://localhost:8788 접속
```

### 환경별 URL

| 환경 | Frontend | Backend | Swagger |
|------|----------|---------|---------|
| 로컬 개발 | `localhost:8788` | `localhost:8787` | `localhost:8787/docs` |
| user1 (프로덕션) | `malgn-chatbot.pages.dev` | `malgn-chatbot-api-user1.workers.dev` | `/docs` |
| cloud (프로덕션) | `malgn-chatbot-cloud.pages.dev` | `malgn-chatbot-api-cloud.workers.dev` | `/docs` |

---

## 7. 멀티테넌트 배포

### Backend 배포 (테넌트별)

```bash
cd ~/Projects/malgn-chatbot-api

# user1 테넌트 배포
wrangler deploy --env user1

# cloud 테넌트 배포
wrangler deploy --env cloud
```

### Frontend 배포 (Cloudflare Pages)

```bash
cd ~/Projects/malgn-chatbot

# 임베드 위젯 빌드 (배포 전 필수)
npm run build

# Pages 배포 (한국어 커밋 메시지 오류 방지를 위해 영문 메시지 지정)
wrangler pages deploy . --project-name=malgn-chatbot --commit-dirty=true --commit-message="deploy"
```

### DB 마이그레이션 (테넌트별)

```bash
# user1 (dev와 Aurora MySQL 공유이므로 별도 불필요)

# cloud (전용 Aurora MySQL 인스턴스)
mysql -h <CLOUD_HOST> -u <USER> -p <DATABASE> < schema.mysql.sql
# 또는 개별 마이그레이션
mysql -h <CLOUD_HOST> -u <USER> -p <DATABASE> < migrations/003_session_parent_id.sql
```

---

## 8. 새 테넌트 추가

### 8.1 Cloudflare 리소스 생성

```bash
# <tenant_id>를 실제 테넌트 ID로 치환

# Aurora MySQL 인스턴스 생성 (AWS RDS)
# - 테넌트별 전용 인스턴스 또는 데이터베이스 추가

# Hyperdrive 구성 (테넌트별)
wrangler hyperdrive create malgn-chatbot-hyperdrive-<tenant_id> \
  --connection-string="mysql://<USER>:<PASSWORD>@<HOST>:3306/<DATABASE>"

# KV 네임스페이스
wrangler kv namespace create malgn-chatbot-kv-<tenant_id>

# R2 버킷
wrangler r2 bucket create malgn-chatbot-files-<tenant_id>

# Vectorize 인덱스 (1024차원)
wrangler vectorize create malgn-chatbot-vectors-<tenant_id> --dimensions=1024 --metric=cosine
```

### 8.2 wrangler.toml에 환경 섹션 추가

```toml
[env.<tenant_id>]
name = "malgn-chatbot-api-<tenant_id>"
vars = { ENVIRONMENT = "production", TENANT_ID = "<tenant_id>" }

[env.<tenant_id>.ai]
binding = "AI"
gateway = { id = "malgn-chatbot", cache_ttl = 3600 }

[[env.<tenant_id>.hyperdrive]]
binding = "HYPERDRIVE"
id = "생성된-hyperdrive-config-id"
# Aurora MySQL connection string은 hyperdrive 구성에 저장됨

[[env.<tenant_id>.kv_namespaces]]
binding = "KV"
id = "생성된-kv-id"

[[env.<tenant_id>.r2_buckets]]
binding = "BUCKET"
bucket_name = "malgn-chatbot-files-<tenant_id>"

[[env.<tenant_id>.vectorize]]
binding = "VECTORIZE"
index_name = "malgn-chatbot-vectors-<tenant_id>"
```

### 8.3 스키마 적용

```bash
mysql -h <TENANT_HOST> -u <USER> -p <DATABASE> < schema.mysql.sql
```

### 8.4 시크릿 설정

```bash
wrangler secret put API_KEY --env <tenant_id>
```

### 8.5 배포

```bash
wrangler deploy --env <tenant_id>
```

---

## 9. 문제 해결

### 자주 발생하는 오류

#### 1. "Unauthorized" (401)

```bash
# API_KEY가 올바른지 확인
# .dev.vars 파일 확인 (로컬)
cat .dev.vars

# 요청 시 Bearer 토큰 포함 필수
curl -H "Authorization: Bearer YOUR_API_KEY" http://localhost:8787/contents
```

#### 2. "Hyperdrive binding not configured" 또는 MySQL 연결 실패

```bash
# Hyperdrive 구성 목록 확인
wrangler hyperdrive list

# wrangler.toml의 [[hyperdrive]] id 확인
# Aurora MySQL 보안 그룹에서 Cloudflare egress IP 허용 확인
```

#### 3. "Vectorize index not found"

```bash
# 인덱스 목록 확인
wrangler vectorize list

# 없으면 생성 (1024차원, 코사인)
wrangler vectorize create malgn-chatbot-vectors --dimensions=1024 --metric=cosine
```

#### 4. "CORS 에러" (브라우저에서)

Hono의 CORS 미들웨어가 이미 설정되어 있습니다. `src/index.js`에서 확인:

```javascript
import { cors } from 'hono/cors';
app.use('*', cors());
```

#### 5. "AI binding error"

Workers AI는 Cloudflare 유료 플랜에서 더 많은 사용량을 제공합니다.
AI Gateway 설정이 `wrangler.toml`에 있는지 확인하세요.

#### 6. Cloudflare Pages 한국어 커밋 오류

```bash
# --commit-message 플래그로 영문 메시지 지정
wrangler pages deploy . --project-name=malgn-chatbot --commit-dirty=true --commit-message="deploy"
```

### 로그 확인

```bash
# 배포된 Worker 실시간 로그
wrangler tail --env user1

# 로컬 개발 시에는 터미널에 로그 자동 출력
```

### 유용한 명령어

```bash
# Wrangler 버전 확인
wrangler --version

# Cloudflare 계정 정보
wrangler whoami

# Aurora MySQL 데이터 조회 (mysql 클라이언트 사용)
mysql -h <HOST> -u <USER> -p <DATABASE> -e "SELECT COUNT(*) FROM TB_CONTENT WHERE status = 1"

# 세션 조회
mysql -h <HOST> -u <USER> -p <DATABASE> -e "SELECT * FROM TB_SESSION WHERE status = 1 LIMIT 10"
```

---

## 체크리스트

### 초기 설정
- [ ] Node.js 18+ 설치됨
- [ ] Wrangler CLI 설치됨
- [ ] Cloudflare 로그인 완료
- [ ] Aurora MySQL 인스턴스 생성됨
- [ ] Hyperdrive 구성 생성됨 (Aurora MySQL 연결)
- [ ] Vectorize 인덱스 생성됨 (1024차원, cosine)
- [ ] KV 네임스페이스 생성됨
- [ ] wrangler.toml에 리소스 ID 입력됨
- [ ] schema.mysql.sql 실행됨
- [ ] .dev.vars에 API_KEY 설정됨
- [ ] npm install 완료
- [ ] 로컬에서 `/health` 테스트 완료

### 배포 전
- [ ] 임베드 위젯 빌드 (`npm run build`)
- [ ] 테넌트별 API_KEY 시크릿 설정됨
- [ ] 테넌트별 Aurora MySQL 마이그레이션 적용됨
- [ ] `wrangler deploy --env <tenant_id>` 성공

---

## 참고 링크

- [Cloudflare Workers 문서](https://developers.cloudflare.com/workers/)
- [Wrangler CLI 문서](https://developers.cloudflare.com/workers/wrangler/)
- [Hyperdrive 문서](https://developers.cloudflare.com/hyperdrive/)
- [AWS RDS Aurora MySQL](https://aws.amazon.com/rds/aurora/)
- [Vectorize 문서](https://developers.cloudflare.com/vectorize/)
- [Workers AI 문서](https://developers.cloudflare.com/workers-ai/)
- [AI Gateway 문서](https://developers.cloudflare.com/ai-gateway/)
- [Hono 공식 문서](https://hono.dev/)
