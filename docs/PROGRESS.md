# Malgn Chatbot 프로젝트 진행 현황

## 프로젝트 개요

- **목표**: LMS(학습관리시스템)에 임베드하여 사용하는 AI 튜터 챗봇
- **아키텍처**: RAG (Retrieval-Augmented Generation) 파이프라인
- **멀티테넌트**: 하나의 코드베이스, 테넌트별 리소스 분리

---

## 현재 기술 스택

| 구분 | 기술 | 설명 |
|------|------|------|
| Backend | Cloudflare Workers + Hono | 서버리스 API |
| Frontend | Cloudflare Pages + Vanilla JS | 관리자 대시보드 + 임베드 위젯 |
| LLM (채팅) | Workers AI `@cf/meta/llama-3.1-8b-instruct` | RAG 기반 응답 생성 |
| LLM (학습/퀴즈) | Workers AI `@cf/meta/llama-3.1-70b-instruct` | 메타데이터/퀴즈 생성 |
| Embedding | Workers AI `@cf/baai/bge-base-en-v1.5` | 768차원 벡터 변환 |
| Vector DB | Cloudflare Vectorize | 코사인 유사도 검색 |
| Database | Cloudflare D1 (SQLite) | 메타데이터 저장 |
| Storage | Cloudflare R2 | 원본 파일 저장 (예약) |
| Cache | Cloudflare KV | 세션 캐시 (24시간 TTL) |
| AI Gateway | Cloudflare AI Gateway | 캐시 3600s, 모니터링 |

---

## 완료된 작업

### Phase 1: 초기 구축

#### 1. Backend 기본 구조
- Cloudflare Workers + Hono 프레임워크 셋업
- 라우트-서비스 레이어 분리 아키텍처
- Bearer 토큰 인증 미들웨어 (`API_KEY`)
- 글로벌 에러 핸들러

#### 2. 콘텐츠 관리 시스템
- 텍스트/파일/링크 등록 (`POST /contents`)
- 파일 업로드: PDF, TXT, MD, SRT, VTT 지원 (최대 10MB)
- 텍스트 추출: `unpdf` 라이브러리 (PDF), 정규식 (SRT/VTT)
- 콘텐츠 CRUD: 목록, 상세, 수정, 삭제

#### 3. 임베딩 시스템
- Workers AI `@cf/baai/bge-base-en-v1.5` (768차원)
- 청크 분할: 500자 단위, 100자 오버랩, 문장 경계 기준
- Vectorize ID 규칙: `content-{contentId}-chunk-{index}`
- 콘텐츠 등록 시 자동 임베딩 저장

#### 4. RAG 채팅 파이프라인
- 5단계 파이프라인: 세션조회 → 벡터검색 → 컨텍스트구축 → LLM호출 → 응답저장
- 2단계 병렬처리 (`Promise.all`)
- XML 태그 기반 시스템 프롬프트 (`<role>`, `<learning_context>`, `<rules>`, `<reference_documents>`)
- 유사도 임계값 0.5 이상 필터링
- 채팅 히스토리 (최근 10개 = 5턴) 참조

#### 5. SSE 스트리밍 채팅
- `POST /chat/stream` SSE 엔드포인트
- 토큰 단위 실시간 스트리밍
- 프론트엔드 EventSource 연동

---

### Phase 2: 학습 기능 고도화

#### 6. 학습 메타데이터 자동 생성
- `learningService.js`: Llama 3.1 70B 사용
- 세션 생성 시 콘텐츠 기반 학습 목표/요약/추천질문 자동 생성
- `executionCtx.waitUntil()`로 백그라운드 비동기 처리
- TB_SESSION에 learning_goal, learning_summary, recommended_questions 저장

#### 7. 세션 제목 자동 생성
- 세션 생성 시 AI가 학습 자료 기반 제목 자동 생성 (15자 이내)
- 생성 실패 시 콘텐츠 제목 조합으로 폴백

#### 8. 퀴즈 자동 생성
- `quizService.js`: Llama 3.1 70B 사용
- 콘텐츠 기반 퀴즈 생성 (4지선다 `choice` + OX `ox`)
- 콘텐츠 등록 시 백그라운드 자동 생성 (`waitUntil`)
- 퀴즈 재생성 API: `POST /contents/:id/quizzes`, `POST /sessions/:id/quizzes`
- 전체 퀴즈 일괄 재생성: `POST /contents/regenerate-all-quizzes`

#### 9. 세션 생성 시 콘텐츠 필수화
- 세션 생성 시 최소 1개 이상의 학습 자료(contentIds) 선택 필수
- TB_SESSION_CONTENT 테이블로 세션-콘텐츠 매핑 관리

---

### Phase 3: DB 스키마 진화

#### 10. 퀴즈 콘텐츠 기반 전환 (migration 001)
- TB_QUIZ: `session_id` → `content_id` FK 변경
- 콘텐츠에 퀴즈가 직접 연결되어 여러 세션에서 공유 가능

#### 11. 세션 LMS 연동 필드 추가 (migration 002)
- `course_id`, `course_user_id`, `lesson_id` 추가
- LMS에서 세션 식별을 위한 외부 키

#### 12. 부모-자식 세션 (migration 003)
- `parent_id` 컬럼 추가 (0=부모/교수자, >0=자식/학습자)
- 교수자 세션: 콘텐츠 연결, AI 설정, 학습 메타데이터 보유
- 학습자 세션: 부모의 콘텐츠/설정 공유, 독립 채팅 히스토리
- 동일 parent + course_user_id 조합 시 기존 세션 반환 (중복 방지)
- `effectiveSessionId`: 자식 세션의 콘텐츠 조회 시 부모 ID 사용

#### 13. 콘텐츠 lesson_id 추가 (migration 004)
- TB_CONTENT에 `lesson_id` 컬럼 추가 (LMS 차시별 콘텐츠 분류)
- `POST /contents`: lesson_id 저장 지원 (JSON, FormData)
- `GET /contents?lesson_id=N`: 차시별 필터링 조회 지원
- `PUT /contents/:id`: lesson_id 수정 지원
- OpenAPI 스펙 (ContentSummary, ContentDetail) 반영

---

### Phase 4: 프론트엔드

#### 14. 관리자 대시보드
- 3컬럼 레이아웃: AI 설정 | 학습 자료 | 채팅 세션
- Bootstrap 5 + Vanilla JS 싱글톤 모듈 패턴
- 이벤트 기반 모듈 통신 (`CustomEvent`)
- 멀티테넌트 전환 UI

#### 15. 임베드 위젯
- ES6 모듈 → esbuild → IIFE 번들 (`chatbot-embed.js`)
- Layer 모드: 플로팅 팝업 + FAB 버튼
- Inline 모드: 지정 컨테이너에 직접 삽입
- 탭 영역: 학습 목표, 핵심 요약, 추천 질문, 퀴즈
- 퀴즈 UI: 4지선다/OX, 오답 시 1회 재시도, 해설 표시
- 설정 옵션: `videoIframeId`, `courseId`, `courseUserId`, `lessonId`, `contentIds`

---

### Phase 5: 인프라 & 품질

#### 16. 멀티테넌트 구조
- `wrangler.toml`의 `[env.<tenant_id>]` 섹션으로 테넌트별 리소스 분리
- 현재 테넌트: dev (로컬), user1 (프로덕션, dev와 DB 공유), user2 (프로덕션, 독립 DB)
- 각 테넌트별 독립: D1, KV, R2, Vectorize, AI Gateway

#### 17. AI Gateway 연동
- Cloudflare AI Gateway (`malgn-chatbot`) 경유
- 캐시 TTL 3600초
- 모니터링 및 로깅

#### 18. Swagger UI / OpenAPI
- `@hono/swagger-ui` 통합
- `GET /docs` — Swagger UI 문서
- `GET /openapi.json` — OpenAPI 3.0 스펙

#### 19. 프론트엔드 학습 데이터 표시
- 세션 로드 시 학습 목표/요약/추천질문 렌더링
- 추천 질문 클릭 시 입력창 자동 입력

#### 20. 시스템 프롬프트 XML 구조화
- `buildSystemPrompt()` 메서드로 일관된 프롬프트 생성
- XML 태그 구조: `<role>`, `<learning_context>`, `<rules>`, `<output_format>`, `<reference_documents>`, `<quiz_info>`
- 퀴즈 정답 정보를 컨텍스트에 포함하여 채팅 중 퀴즈 질문 대응

#### 21. 전체 콘텐츠 재임베딩
- `POST /contents/reembed` — 모든 콘텐츠 재임베딩 API
- 임베딩 모델 변경 시 일괄 재처리 가능

---

## 파일 구조

```
malgn-chatbot-api/
├── src/
│   ├── index.js                 # Hono 엔트리 포인트 + Swagger UI
│   ├── openapi.js               # OpenAPI 3.0 스펙
│   ├── routes/
│   │   ├── chat.js              # POST /chat, /chat/stream
│   │   ├── contents.js          # CRUD + 퀴즈 + 재임베딩
│   │   ├── sessions.js          # CRUD + 퀴즈 + 부모-자식
│   │   └── users.js             # 사용자 관련 (미사용)
│   ├── services/
│   │   ├── chatService.js       # RAG 파이프라인 (5단계, 2단계 병렬)
│   │   ├── contentService.js    # 콘텐츠 업로드, 텍스트 추출, 임베딩
│   │   ├── embeddingService.js  # 768차원 벡터 변환, 청크 분할
│   │   ├── learningService.js   # 학습 메타데이터 생성 (70B)
│   │   ├── quizService.js       # 퀴즈 생성 (70B)
│   │   ├── openaiService.js     # OpenAI 연동 (선택적)
│   │   └── userService.js       # 사용자 관리 (미사용)
│   ├── middleware/
│   │   ├── auth.js              # Bearer 토큰 인증
│   │   └── errorHandler.js      # 글로벌 에러 핸들러
│   └── utils/
│       └── utils.js             # 유틸리티 함수
├── migrations/
│   ├── 001_quiz_content_based.sql
│   ├── 002_session_course_fields.sql
│   └── 003_session_parent_id.sql
├── schema.sql                   # 전체 D1 스키마
├── wrangler.toml                # 멀티테넌트 Cloudflare 설정
├── package.json                 # hono, @hono/swagger-ui, jose, pdf-parse, unpdf
└── docs/                        # 프로젝트 문서
```

---

## API 엔드포인트 요약

### 공개 (인증 불필요)

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/health` | 헬스체크 |
| GET | `/docs` | Swagger UI 문서 |
| GET | `/openapi.json` | OpenAPI 스펙 |

### 인증 필요 (`Authorization: Bearer {API_KEY}`)

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/chat` | 동기 채팅 (RAG 파이프라인) |
| POST | `/chat/stream` | SSE 스트리밍 채팅 |
| GET | `/sessions` | 세션 목록 (부모만) |
| POST | `/sessions` | 세션 생성 (부모 또는 자식) |
| GET | `/sessions/:id` | 세션 상세 (메시지 + 학습데이터) |
| PUT | `/sessions/:id` | 세션 AI 설정 업데이트 |
| DELETE | `/sessions/:id` | 세션 삭제 (자식 연쇄 삭제) |
| GET | `/sessions/:id/quizzes` | 세션 퀴즈 조회 |
| POST | `/sessions/:id/quizzes` | 세션 퀴즈 재생성 |
| GET | `/contents` | 콘텐츠 목록 |
| POST | `/contents` | 콘텐츠 등록 (text/file/link) |
| GET | `/contents/:id` | 콘텐츠 상세 |
| PUT | `/contents/:id` | 콘텐츠 수정 |
| DELETE | `/contents/:id` | 콘텐츠 삭제 |
| GET | `/contents/:id/quizzes` | 콘텐츠 퀴즈 조회 |
| POST | `/contents/:id/quizzes` | 콘텐츠 퀴즈 재생성 |
| POST | `/contents/regenerate-all-quizzes` | 전체 퀴즈 재생성 |
| POST | `/contents/reembed` | 전체 콘텐츠 재임베딩 |

---

## 환경 변수

### 로컬 개발 (`.dev.vars`)
```
API_KEY=your-api-key-here
```

### 프로덕션 (Wrangler Secrets)
```bash
wrangler secret put API_KEY --env user1
wrangler secret put API_KEY --env user2
```
