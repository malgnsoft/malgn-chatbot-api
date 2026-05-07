# 프로젝트 구조 (Project Structure)

이 문서는 Malgn Chatbot 프로젝트의 전체 구조를 설명합니다.

---

## 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        사용자 브라우저                           │
│           (관리자 대시보드 / 임베드 위젯)                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP 요청
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages                             │
│              (정적 파일 호스팅, 테넌트별 배포)                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ REST API / SSE 스트리밍
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Cloudflare Workers                             │
│               (malgn-chatbot-api Backend)                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Hono Framework                         │  │
│  │  ┌───────────┐  ┌───────────┐  ┌──────────────────┐     │  │
│  │  │ Middleware │→ │  Routes   │→ │    Services      │     │  │
│  │  │ (auth,    │  │ (chat,    │  │ (chatService,    │     │  │
│  │  │  error)   │  │  sessions,│  │  contentService, │     │  │
│  │  │           │  │  contents)│  │  embeddingService,│     │  │
│  │  └───────────┘  └───────────┘  │  learningService,│     │  │
│  │                                │  quizService)    │     │  │
│  │                                └──────────────────┘     │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────┬──────────┬──────────┬──────────┬───────────────┘
                │          │          │          │
        ┌───────┘    ┌─────┘    ┌─────┘    ┌────┘
        ▼            ▼          ▼          ▼
┌────────────┐ ┌──────────┐ ┌────────────┐ ┌───────┐
│ Workers AI │ │Vectorize │ │ Hyperdrive │ │  KV   │
│ (LLM +    │ │(벡터검색)│ │ → Aurora   │ │(캐시) │
│ 임베딩 +  │ │ 1024차원 │ │   MySQL    │ │24h TTL│
│ AI Gateway)│ │코사인유사│ │            │ │       │
└────────────┘ └──────────┘ └────────────┘ └───────┘
```

---

## 저장소 구조

```
Projects/
├── malgn-chatbot/              # Frontend (Cloudflare Pages)
│   ├── index.html              # 관리자 대시보드 (3컬럼 레이아웃)
│   ├── package.json            # esbuild 빌드 설정
│   ├── css/
│   │   ├── style.css           # 대시보드 스타일
│   │   └── chatbot.css         # 임베드 위젯 스타일
│   ├── js/
│   │   ├── app.js              # 메인 오케스트레이터 (초기화, 이벤트 바인딩)
│   │   ├── api.js              # REST API 클라이언트 (대시보드용)
│   │   ├── chat.js             # 채팅 메시지 송수신
│   │   ├── contents.js         # 콘텐츠 관리 (텍스트/파일/링크 업로드)
│   │   ├── sessions.js         # 세션 목록/생성/삭제
│   │   ├── settings.js         # AI 설정 (persona, temperature 등)
│   │   ├── tenants.js          # 멀티테넌트 전환
│   │   ├── chatbot-embed.js    # 빌드된 임베드 위젯 (IIFE 번들)
│   │   └── embed/              # 임베드 위젯 소스 (ES6 모듈)
│   │       ├── index.js        # 진입점, 설정 파싱
│   │       ├── api.js          # API 클라이언트 클래스
│   │       ├── chat.js         # ChatManager (메시지/스트리밍)
│   │       ├── ui.js           # DOM 주입, FAB 버튼
│   │       ├── tabs.js         # TabManager (목표/요약/추천/퀴즈 탭)
│   │       ├── quiz.js         # QuizManager (퀴즈 렌더링/검증)
│   │       └── utils.js        # 유틸리티 (escapeHtml, formatContent)
│   └── docs/
│       └── history/            # 작업 히스토리 문서
│
├── malgn-chatbot-api/          # Backend (Cloudflare Workers)
│   ├── src/
│   │   ├── index.js            # Hono 앱 엔트리 포인트 + 라우팅 + Swagger UI
│   │   ├── openapi.js          # OpenAPI 3.0 스펙 정의
│   │   ├── routes/
│   │   │   ├── chat.js         # POST /chat, /chat/stream
│   │   │   ├── sessions.js     # GET/POST/PUT/DELETE /sessions
│   │   │   ├── contents.js     # GET/POST/PUT/DELETE /contents
│   │   │   └── users.js        # 사용자 관련 (미사용)
│   │   ├── services/
│   │   │   ├── chatService.js      # RAG 파이프라인 + LLM 응답 생성
│   │   │   ├── contentService.js   # 콘텐츠 업로드, 텍스트 추출, 임베딩
│   │   │   ├── embeddingService.js # 텍스트→벡터 변환 (1024차원)
│   │   │   ├── learningService.js  # 학습 메타데이터 생성 (목표/요약/추천질문)
│   │   │   ├── quizService.js      # 퀴즈 생성 (4지선다 + OX)
│   │   │   ├── openaiService.js    # OpenAI 연동 (선택적)
│   │   │   └── userService.js      # 사용자 관리 (미사용)
│   │   ├── middleware/
│   │   │   ├── auth.js             # Bearer 토큰 인증 (API_KEY)
│   │   │   └── errorHandler.js     # 글로벌 에러 핸들러
│   │   └── utils/
│   │       └── utils.js            # 유틸리티 함수
│   ├── migrations/
│   │   ├── 001_quiz_content_based.sql      # TB_QUIZ 콘텐츠 기반 리팩토링
│   │   ├── 002_session_course_fields.sql   # course_id, course_user_id, lesson_id 추가
│   │   ├── 003_session_parent_id.sql       # parent_id 추가 (부모-자식 세션)
│   │   ├── 004_content_lesson_id.sql       # TB_CONTENT에 lesson_id 추가
│   │   ├── 005_session_quiz_difficulty.sql # quiz_difficulty (easy/normal/hard)
│   │   ├── 005_session_quiz_split.sql      # 퀴즈 설정 분리 (choice_count/ox_count)
│   │   ├── 006_quiz_session_id.sql         # TB_QUIZ에 session_id 추가
│   │   ├── 006_session_generation_status.sql # 세션 generation_status 추가
│   │   ├── 007_session_chat_content_ids.sql # 세션별 chat_content_ids 추가
│   │   ├── 008_add_site_id.sql             # 멀티사이트 site_id 추가
│   │   ├── 009_ai_log.sql                  # TB_AI_LOG 추가
│   │   └── 010_ai_log_lesson_id.sql        # TB_AI_LOG content_id → lesson_id
│   ├── schema.mysql.sql        # 전체 Aurora MySQL 스키마
│   ├── wrangler.toml           # 멀티테넌트 Cloudflare 설정
│   ├── package.json            # Hono, pdf-parse, unpdf, jose, @hono/swagger-ui
│   └── docs/                   # API 문서
│
├── malgn-chatbot-user1/        # user1 테넌트 프론트엔드 배포본
└── malgn-chatbot-cloud/        # cloud 테넌트 프론트엔드 배포본
```

---

## Backend 폴더 상세 설명

### `src/routes/` - API 라우트

API 엔드포인트를 정의하는 폴더입니다.

| 파일 | 역할 | 주요 엔드포인트 |
|------|------|----------------|
| `chat.js` | 채팅 기능 | `POST /chat`, `POST /chat/stream` |
| `sessions.js` | 세션 관리 | `GET/POST/PUT/DELETE /sessions`, 퀴즈 조회/생성 |
| `contents.js` | 콘텐츠 관리 | `GET/POST/PUT/DELETE /contents`, 퀴즈, 재임베딩 |
| `users.js` | 사용자 관리 | (현재 미등록) |

**규칙**:
- 비즈니스 로직은 포함하지 않음 — Service 레이어에 위임
- `executionCtx.waitUntil()`로 LLM 호출(퀴즈/학습데이터)을 백그라운드 처리

### `src/services/` - 서비스 레이어

비즈니스 로직을 처리하는 폴더입니다.

| 파일 | 역할 |
|------|------|
| `chatService.js` | RAG 파이프라인: 벡터 검색 → 컨텍스트 구축 → LLM 응답 생성 |
| `contentService.js` | 콘텐츠 업로드, PDF/SRT/VTT 텍스트 추출, 청크 분할, 임베딩 저장 |
| `embeddingService.js` | 텍스트→1024차원 벡터 변환, 청크 분할 (500자, 100자 오버랩) |
| `learningService.js` | 학습 목표/요약/추천질문 자동 생성 (Gemma 3 12B) |
| `quizService.js` | 4지선다 + OX 퀴즈 자동 생성 (Gemma 3 12B) |
| `openaiService.js` | OpenAI API 연동 (선택적 대안) |
| `userService.js` | 사용자 관리 (미사용) |

**규칙**:
- 모든 서비스는 **클래스** 형태
- 생성자에서 `env` 객체를 받아 Cloudflare 바인딩 접근

```javascript
// 서비스 클래스 패턴
export class ChatService {
  constructor(env) {
    this.env = env;  // DB, AI, VECTORIZE, KV 등
  }

  async chat(message, sessionId) {
    // RAG 파이프라인 실행
  }
}
```

### `src/middleware/` - 미들웨어

| 파일 | 역할 |
|------|------|
| `auth.js` | Bearer 토큰 인증 (`Authorization: Bearer {API_KEY}`) |
| `errorHandler.js` | 전역 에러 처리 + 표준 에러 응답 포맷 |

### `src/utils/` - 유틸리티

| 파일 | 역할 |
|------|------|
| `utils.js` | UUID 생성, 날짜 포맷, 기타 헬퍼 함수 |

---

## Frontend 폴더 상세 설명

### 관리자 대시보드 (`js/`)

| 파일 | 역할 |
|------|------|
| `app.js` | 앱 초기화, 이벤트 리스너, 모듈 간 통신 |
| `api.js` | Backend API 호출 (대시보드용 REST 클라이언트) |
| `chat.js` | 채팅 UI, 메시지 송수신, 학습데이터 표시 |
| `contents.js` | 콘텐츠 업로드/목록/편집/삭제 UI |
| `sessions.js` | 세션 목록/생성/삭제 UI |
| `settings.js` | AI 설정 UI (persona, temperature, topP, maxTokens 등) |
| `tenants.js` | 멀티테넌트 전환 UI |

**모듈 패턴**: Vanilla JS 싱글톤 — `const ModuleName = { init(), ... }`

### 임베드 위젯 (`js/embed/`)

| 파일 | 역할 |
|------|------|
| `index.js` | 진입점, `window.MalgnTutor` 설정 파싱 |
| `api.js` | API 클라이언트 클래스 (Bearer 토큰 인증) |
| `chat.js` | ChatManager (메시지 관리, SSE 스트리밍) |
| `ui.js` | DOM 주입, FAB 버튼, Layer/Inline 모드 |
| `tabs.js` | TabManager (학습 목표/요약/추천질문/퀴즈 탭) |
| `quiz.js` | QuizManager (퀴즈 렌더링, 정답 검증, 재시도) |
| `utils.js` | 유틸리티 (escapeHtml, formatContent) |

**빌드**: ES6 모듈 → esbuild → IIFE 번들 (`chatbot-embed.js`)

---

## 데이터 흐름

### 1. 콘텐츠 등록 흐름

```
사용자 → 텍스트/파일/링크 입력 → Frontend (contents.js)
                                    ↓ POST /contents
                              Backend (routes/contents.js)
                                    ↓
                              ContentService
                                    ↓
                    ┌───────────────┼────────────────┐
                    ↓               ↓                ↓
              텍스트 추출      MySQL 저장       EmbeddingService
              (PDF: unpdf,   (TB_CONTENT)     (청크 분할 500자,
               SRT/VTT 등)                    100자 오버랩)
                                                    ↓
                                              Vectorize 저장
                                              (1024차원 벡터)
                                                    ↓
                                           [백그라운드] 퀴즈 생성
                                           (executionCtx.waitUntil)
```

### 2. 세션 생성 흐름 (부모-자식 패턴)

```
교수자 → 세션 생성 (parent_id=0, contentIds)
                    ↓ POST /sessions
              TB_SESSION 생성 + TB_SESSION_CONTENT 연결
                    ↓
            [백그라운드] LearningService
              ├── 콘텐츠 텍스트 수집
              ├── Gemma 3 12B로 학습 목표/요약/추천질문 생성
              └── TB_SESSION에 저장

학습자 → 세션 생성 (parent_id=교수자세션ID, courseUserId)
                    ↓
              동일 parent+courseUserId → 기존 자식 세션 반환
              새로운 경우 → 자식 세션 생성 (부모의 콘텐츠/설정 공유)
```

### 3. RAG 채팅 흐름

```
사용자 질문 입력
    │
    ▼
[1단계 병렬 처리] ─── Promise.all ───
    ├── 세션 콘텐츠 ID 조회 (parent_id 처리)
    ├── 질문 임베딩 (1024차원 벡터 변환)
    └── 세션 학습 데이터 조회 (DB 직접)
    │
    ▼
[2단계 병렬 처리] ─── Promise.all ───
    ├── Vectorize 유사 문서 검색 (top 5, 임계값 0.5)
    ├── 채팅 히스토리 조회 (최근 10개 = 5턴)
    └── 퀴즈 컨텍스트 조회 (정답 정보)
    │
    ▼
[3단계] 시스템 프롬프트 구축 (XML 태그 구조)
    ├── <role>              : AI 튜터 페르소나
    ├── <learning_context>  : 학습 목표 + 핵심 요약 + 추천 질문
    ├── <rules>             : 응답 규칙
    ├── <output_format>     : 출력 형식 가이드
    ├── <reference_documents>: RAG 검색 결과 문서
    └── <quiz_info>         : 퀴즈 정답 정보
    │
    ▼
[4단계] LLM 호출 (Gemma 3 12B via AI Gateway)
    messages = [system, ...history, user]
    │
    ▼
[5단계] 응답 저장 및 반환
    ├── TB_MESSAGE에 user/assistant 메시지 저장
    └── { response, sources, sessionId } 반환
```

---

## 멀티테넌트 구조

| 테넌트 | 환경 | Workers 이름 | DB |
|--------|------|-------------|-----|
| dev | 로컬 개발 | malgn-chatbot-api | Aurora MySQL (Hyperdrive) |
| user1 | 프로덕션 | malgn-chatbot-api-user1 | Aurora MySQL (dev와 공유) |
| cloud | 프로덕션 | malgn-chatbot-api-cloud | Aurora MySQL (전용 인스턴스, 독립) |

각 테넌트별 독립 리소스: Aurora MySQL DB, KV, R2, Vectorize, AI Gateway

---

## 다음 단계

- [기술 스택 설명](./TECH_STACK.md) - 사용된 기술 상세 설명
- [API 명세서](./API_SPECIFICATION.md) - API 엔드포인트 상세
- [데이터베이스 스키마](./DATABASE_SCHEMA.md) - DB 구조
- [환경 설정 가이드](./SETUP_GUIDE.md) - 개발 환경 설정
- [개발 가이드](./DEVLOPMENT_GUIDE.md) - 코딩 컨벤션 및 아키텍처 패턴
