# 개발 가이드 (Development Guide)

이 문서는 Malgn Chatbot API 프로젝트의 개발 표준 가이드입니다. 새로운 기능을 추가하거나 코드를 작성할 때 이 가이드를 참고하세요.

## 목차

- [프로젝트 구조](#프로젝트-구조)
- [코딩 컨벤션](#코딩-컨벤션)
- [아키텍처 패턴](#아키텍처-패턴)
- [Cloudflare 바인딩 사용](#cloudflare-바인딩-사용)
- [인증 및 보안](#인증-및-보안)
- [환경 변수 관리](#환경-변수-관리)
- [에러 처리](#에러-처리)
- [RAG 파이프라인](#rag-파이프라인)
- [부모-자식 세션](#부모-자식-세션)

---

## 프로젝트 구조

```
src/
├── index.js                # 엔트리 포인트 + 라우팅 + CORS + Swagger UI
├── openapi.js              # OpenAPI 3.0 스펙
├── routes/                 # API 라우트 핸들러
│   ├── chat.js             # 채팅 (동기 + SSE 스트리밍)
│   ├── sessions.js         # 세션 CRUD + 퀴즈
│   └── contents.js         # 콘텐츠 CRUD + 퀴즈 + 재임베딩
├── services/               # 비즈니스 로직 (클래스 기반)
│   ├── chatService.js      # RAG 파이프라인 + LLM 응답 생성
│   ├── contentService.js   # 콘텐츠 업로드, 텍스트 추출, 임베딩
│   ├── embeddingService.js # 텍스트→벡터 변환
│   ├── learningService.js  # 학습 메타데이터 생성
│   ├── quizService.js      # 퀴즈 생성 (4지선다 + OX)
│   └── openaiService.js    # OpenAI 연동 (선택)
├── utils/
│   └── utils.js            # 유틸리티 함수
└── middleware/
    ├── auth.js             # Bearer 토큰 인증
    └── errorHandler.js     # 글로벌 에러 핸들러
```

### 폴더별 역할

#### `routes/`
- HTTP 요청/응답 처리, 입력 검증
- 서비스 호출 후 응답 반환
- **규칙**: 비즈니스 로직 포함 금지, 서비스 레이어에 위임
- **예외**: `sessions.js`는 DB 직접 조회 포함 (세션 생성/조회 복잡도로 인해)

#### `services/`
- 비즈니스 로직, AI 모델 호출, 데이터 처리
- **규칙**: 반드시 클래스 기반, `constructor(env)` 또는 `constructor(env, executionCtx)` 패턴

#### `utils/`
- 범용 유틸리티 함수
- **규칙**: 상태 없는(stateless) 함수

#### `middleware/`
- 인증, 에러 핸들링
- **규칙**: Hono 미들웨어 패턴 사용

---

## 코딩 컨벤션

### 파일명
- **서비스**: `camelCase` (예: `chatService.js`, `contentService.js`)
- **라우트**: `camelCase` (예: `sessions.js`, `contents.js`)
- **유틸리티**: `camelCase` (예: `utils.js`)

### 변수/함수명
- **변수**: `camelCase`
- **함수**: `camelCase`
- **클래스**: `PascalCase` (예: `ChatService`, `QuizService`)
- **상수**: `UPPER_SNAKE_CASE`
- **DB 컬럼**: `snake_case` (예: `content_nm`, `parent_id`, `created_at`)

### Export 패턴

```javascript
// Services → named export 클래스
export class ChatService {
  constructor(env) { this.env = env; }
}

// Routes → default export Hono 인스턴스
const sessions = new Hono();
export default sessions;

// Middleware → named export 함수
export const authMiddleware = async (c, next) => { ... };
```

### DB 쿼리 규칙

```javascript
// ✅ 항상 status = 1 필터링
const session = await c.env.DB
  .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
  .bind(id)
  .first();

// ❌ status 필터 누락 금지
const session = await c.env.DB
  .prepare('SELECT * FROM TB_SESSION WHERE id = ?')
  .bind(id)
  .first();

// ✅ 삭제는 soft delete
await c.env.DB
  .prepare('UPDATE TB_SESSION SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
  .bind(id)
  .run();

// ❌ 물리 삭제 금지
await c.env.DB
  .prepare('DELETE FROM TB_SESSION WHERE id = ?')
  .bind(id)
  .run();
```

---

## 아키텍처 패턴

### 레이어 구조

```
Request → Middleware(auth) → Route → Service → DB/AI/Vectorize → Response
```

### 서비스 레이어 패턴

```javascript
export class ContentService {
  constructor(env, executionCtx) {
    this.env = env;
    this.executionCtx = executionCtx;  // waitUntil용
  }

  async uploadText(title, content) {
    // 1. DB 저장
    const result = await this.env.DB
      .prepare('INSERT INTO TB_CONTENT ...')
      .bind(...)
      .run();

    const contentId = result.meta.last_row_id;

    // 2. 임베딩 + Vectorize 저장
    await this.storeContentEmbedding(contentId, title, content);

    // 3. 퀴즈 생성 (백그라운드)
    if (this.executionCtx) {
      this.executionCtx.waitUntil(
        this.generateQuizForContent(contentId, content)
      );
    }

    return { id: contentId, ... };
  }
}
```

### 라우트 패턴

```javascript
import { Hono } from 'hono';
import { ContentService } from '../services/contentService.js';

const contents = new Hono();

contents.post('/', async (c) => {
  try {
    // executionCtx 전달 (waitUntil 사용 시)
    const contentService = new ContentService(c.env, c.executionCtx);
    const result = await contentService.uploadText(title, content);

    return c.json({
      success: true,
      data: result,
      message: '성공 메시지'
    }, 201);

  } catch (error) {
    console.error('Error:', error);
    return c.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '오류 메시지' }
    }, 500);
  }
});

export default contents;
```

### 병렬 처리 패턴

독립적인 비동기 작업은 항상 `Promise.all()`로 병렬 실행합니다.

```javascript
// ✅ 병렬 처리
const [contentResult, queryEmbedding, learningData] = await Promise.all([
  this.getSessionContentIdsAndParent(sessionId),
  this.embeddingService.embed(message),
  this.getSessionLearningData(sessionId)
]);

// ❌ 순차 처리 (독립 작업인데 직렬)
const contentResult = await this.getSessionContentIdsAndParent(sessionId);
const queryEmbedding = await this.embeddingService.embed(message);
const learningData = await this.getSessionLearningData(sessionId);
```

### 비동기 백그라운드 작업

LLM 호출(퀴즈/학습데이터 생성)은 `executionCtx.waitUntil()`로 응답 후 처리합니다.

```javascript
// ✅ 응답 먼저 보내고 백그라운드에서 퀴즈 생성
c.executionCtx.waitUntil(
  contentService.generateQuizForContent(contentId, content)
);
return c.json({ success: true, data: result }, 201);

// ❌ 퀴즈 생성 완료를 기다린 후 응답 (느림)
await contentService.generateQuizForContent(contentId, content);
return c.json({ success: true, data: result }, 201);
```

---

## Cloudflare 바인딩 사용

Cloudflare 바인딩은 `c.env` 또는 `this.env`에서 직접 사용합니다.

### AI (Workers AI)

```javascript
// 채팅 LLM (Gemma 3 12B - 다국어/추론 균형)
const response = await this.env.AI.run('@cf/google/gemma-3-12b-it', {
  messages: [{ role: 'system', content: systemPrompt }, ...],
  temperature: 0.3,
  top_p: 0.3,
  max_tokens: 1024
});

// 학습/퀴즈 LLM (동일 모델, AI Gateway 캐시)
const response = await this.env.AI.run('@cf/google/gemma-3-12b-it', {
  messages: [...],
  temperature: 0.3
}, { gateway: { id: 'malgn-chatbot', cacheTtl: 3600 } });

// 임베딩 (1024차원, 다국어)
const result = await this.env.AI.run('@cf/baai/bge-m3', {
  text: [inputText]
});
const vector = result.data[0];  // [0.012, -0.034, ...]
```

### Aurora MySQL (Hyperdrive 경유)

> 코드의 `this.env.DB` 변수명은 그대로 유지되지만 실제 바인딩 대상은 Hyperdrive를 통한 Aurora MySQL 커넥션을 래핑한 헬퍼입니다. 본 프로젝트에서는 자체 DB 헬퍼(`db.execute`/`db.first`/`db.all`)를 통해 D1과 유사한 인터페이스를 제공합니다.

```javascript
// 단일 행 조회
const session = await this.env.DB
  .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
  .bind(sessionId)
  .first();

// 여러 행 조회
const { results } = await this.env.DB
  .prepare('SELECT * FROM TB_MESSAGE WHERE session_id = ? AND status = 1 ORDER BY created_at ASC')
  .bind(sessionId)
  .all();

// INSERT (last_row_id 반환)
const result = await this.env.DB
  .prepare('INSERT INTO TB_SESSION (parent_id, persona, ...) VALUES (?, ?, ...)')
  .bind(0, persona, ...)
  .run();
const newId = result.meta.last_row_id;
```

### Vectorize

```javascript
// 벡터 저장
await this.env.VECTORIZE.upsert([{
  id: `content-${contentId}-chunk-${index}`,
  values: embeddingVector,  // 1024차원 float 배열
  metadata: { type: 'content', contentId, text: chunkText }
}]);

// 유사도 검색 (top 5, 임계값 0.5)
const queryResult = await this.env.VECTORIZE.query(queryVector, {
  topK: 5,
  filter: { type: 'content' },
  returnValues: false,
  returnMetadata: 'all'
});

// 벡터 삭제
await this.env.VECTORIZE.deleteByIds([
  `session-${sessionId}-goal`,
  `session-${sessionId}-summary`
]);
```

### KV (Key-Value)

```javascript
// 세션 캐시 저장 (24시간 TTL)
await this.env.KV.put(`session:${sessionId}`, JSON.stringify(data), {
  expirationTtl: 86400
});

// 캐시 조회
const cached = await this.env.KV.get(`session:${sessionId}`, { type: 'json' });
```

### R2 (Object Storage)

```javascript
// 파일 업로드
await this.env.BUCKET.put(`files/${contentId}/${filename}`, fileData);

// 파일 다운로드
const object = await this.env.BUCKET.get(`files/${contentId}/${filename}`);
const data = await object.arrayBuffer();
```

---

## 인증 및 보안

### Bearer 토큰 인증

보호 경로에 `authMiddleware`가 적용됩니다.

```javascript
// src/index.js
app.use('/chat/*', authMiddleware);
app.use('/contents/*', authMiddleware);
app.use('/sessions/*', authMiddleware);
```

인증 미들웨어는 `Authorization: Bearer {API_KEY}` 헤더를 검증합니다. API_KEY는 `wrangler secret put API_KEY`로 설정합니다.

### 공개 경로 (인증 불필요)

- `GET /` — 문서 리다이렉트
- `GET /health` — 헬스체크
- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 스펙

---

## 환경 변수 관리

### 로컬 개발 (`.dev.vars`)

```
API_KEY=your-api-key-here
```

> `.dev.vars`는 git에 커밋하지 마세요!

### Production (Wrangler Secrets)

```bash
wrangler secret put API_KEY --env user1
wrangler secret put API_KEY --env cloud
```

### 환경 변수 접근

```javascript
// 서비스 클래스 내부
constructor(env) {
  this.db = env.DB;
  this.ai = env.AI;
  this.vectorize = env.VECTORIZE;
}

// 라우트에서 직접
const environment = c.env.ENVIRONMENT;  // 'development' | 'production'
const tenantId = c.env.TENANT_ID;       // 'dev' | 'user1' | 'cloud'
```

---

## 에러 처리

### 표준 에러 응답 형식

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "사용자 친화적 메시지",
    "detail": "개발자용 상세 정보 (선택)"
  }
}
```

### 에러 코드 매핑

| 에러 코드 | HTTP 상태 | 설명 |
|-----------|-----------|------|
| UNAUTHORIZED | 401 | 인증 실패 |
| VALIDATION_ERROR | 400 | 입력값 검증 실패 |
| NOT_FOUND | 404 | 리소스 없음 |
| NO_CONTENT | 400 | 연결된 콘텐츠 없음 |
| FILE_TOO_LARGE | 413 | 파일 크기 초과 (10MB) |
| UNSUPPORTED_FILE_TYPE | 415 | 지원하지 않는 파일 형식 |
| URL_ERROR | 400 | URL 접근/처리 오류 |
| EXTRACTION_ERROR | 400 | 텍스트 추출 실패 |
| EMBEDDING_ERROR | 500 | 임베딩 생성 실패 |
| AI_ERROR | 500 | AI 응답 생성 실패 |
| INTERNAL_ERROR | 500 | 내부 서버 오류 |

### 글로벌 에러 핸들러 (`src/middleware/errorHandler.js`)

`app.onError(errorHandler)`로 등록되어 미처리 에러를 자동 처리합니다.

---

## RAG 파이프라인

채팅 요청 시 `chatService.js`에서 실행되는 5단계 파이프라인:

```
[1단계 병렬] Promise.all
  ├── 세션 콘텐츠 ID 조회 (parent_id 처리)
  ├── 질문 임베딩 (1024차원)
  └── 세션 학습 데이터 조회 (DB 직접)

[2단계 병렬] Promise.all
  ├── Vectorize 유사 문서 검색 (top 5, 임계값 0.5)
  ├── 채팅 히스토리 조회 (최근 10개 = 5턴)
  └── 퀴즈 컨텍스트 조회

[3단계] 시스템 프롬프트 구축 (buildSystemPrompt)
  ├── <role> — AI 튜터 페르소나
  ├── <learning_context> — 학습 목표 + 요약 + 추천 질문
  ├── <rules> — 8개 응답 규칙
  ├── <output_format> — 마크다운 포맷 가이드
  ├── <reference_documents> — RAG 검색 결과
  └── <quiz_info> — 퀴즈 정답 정보

[4단계] LLM 호출 (Gemma 3 12B)

[5단계] 메시지 저장 + 응답 반환
```

### 주요 메서드

| 메서드 | 설명 |
|--------|------|
| `chat()` | 동기 RAG 파이프라인 전체 실행 |
| `prepareChatContext()` | 스트리밍용 컨텍스트 준비 |
| `generateResponseStream()` | LLM 스트리밍 응답 생성 |
| `buildSystemPrompt()` | XML 태그 기반 시스템 프롬프트 빌더 |
| `getSessionContentIdsAndParent()` | 세션 콘텐츠 ID + parent_id 처리 |
| `getSessionLearningData()` | DB에서 학습 데이터 직접 조회 |
| `searchSimilarDocuments()` | Vectorize 유사도 검색 |
| `getQuizContext()` | 퀴즈 정답 정보 조회 |

---

## 부모-자식 세션

### 구조

```
부모 세션 (parent_id = 0) — 교수자가 생성
  ├── TB_SESSION_CONTENT — 콘텐츠 연결
  ├── learning_goal, learning_summary, recommended_questions
  └── Vectorize 임베딩: session-{id}-goal, session-{id}-summary

자식 세션 (parent_id > 0) — 학습자별 자동 생성
  ├── 부모의 콘텐츠·학습데이터·임베딩 공유
  ├── 고유 LMS 키 (course_id, course_user_id, lesson_id)
  └── 고유 TB_MESSAGE (개인 채팅 기록)
```

### 핵심 규칙

1. `effectiveSessionId`: 자식 세션은 콘텐츠/학습데이터 조회 시 부모 ID 사용
2. 동일 `parent_id + course_user_id` 조합이면 기존 자식 세션 반환 (중복 방지)
3. 자식 세션 생성 시 AI 학습데이터 재생성 없음 (부모 데이터 공유)
4. 부모 세션 삭제 시 자식 세션 연쇄 soft delete

---

## 새로운 기능 추가 가이드

### 1. 새로운 엔드포인트 추가

```bash
# 1. 라우트 파일 생성
src/routes/newFeature.js

# 2. 서비스 생성 (필요시)
src/services/newFeatureService.js

# 3. src/index.js에 라우트 등록
import newFeatureRoutes from './routes/newFeature.js';
app.use('/new-feature/*', authMiddleware);  // 인증 필요 시
app.route('/new-feature', newFeatureRoutes);

# 4. openapi.js에 스펙 추가
```

### 2. 새로운 서비스 추가

```javascript
// src/services/newFeatureService.js
export class NewFeatureService {
  constructor(env) {
    this.env = env;
  }

  async getData() {
    const { results } = await this.env.DB
      .prepare('SELECT * FROM TB_NEW_TABLE WHERE status = 1')
      .all();
    return results;
  }
}
```

---

## 금지 사항

1. **DB 물리 삭제 금지** — 반드시 soft delete (`status = -1`)
2. **status 필터 누락 금지** — 모든 SELECT에 `WHERE status = 1`
3. **Vectorize 의존 학습 데이터 조회 금지** — DB 직접 조회 사용
4. **시스템 프롬프트 하드코딩 금지** — `buildSystemPrompt()` 사용
5. **동기 대기 금지** — LLM 호출은 `waitUntil()`로 비동기 처리
6. **wrangler.toml에 시크릿 기입 금지** — `wrangler secret put` 사용

---

## 참고 자료

- [Cloudflare Workers 문서](https://developers.cloudflare.com/workers/)
- [Hono 문서](https://hono.dev/)
- [Cloudflare Hyperdrive 문서](https://developers.cloudflare.com/hyperdrive/)
- [AWS RDS Aurora MySQL](https://aws.amazon.com/rds/aurora/)
- [Cloudflare Vectorize 문서](https://developers.cloudflare.com/vectorize/)
- [Cloudflare AI Gateway 문서](https://developers.cloudflare.com/ai-gateway/)
