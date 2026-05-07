# 기술 스택 (Tech Stack)

이 문서는 Malgn Chatbot 프로젝트에서 사용하는 기술들을 설명합니다.

---

## 목차

1. [전체 기술 스택 요약](#전체-기술-스택-요약)
2. [Cloudflare 서비스](#cloudflare-서비스)
3. [RAG란 무엇인가?](#rag란-무엇인가)
4. [사용 기술 상세](#사용-기술-상세)
5. [용어 설명](#용어-설명)

---

## 전체 기술 스택 요약

| 구분 | 기술 | 설명 |
|------|------|------|
| **런타임** | Cloudflare Workers | 서버리스 엣지 컴퓨팅 |
| **프레임워크** | Hono | 경량 웹 프레임워크 |
| **프론트엔드** | Vanilla JS + Bootstrap 5 | 프레임워크 없는 순수 JS |
| **번들러** | esbuild | 임베드 위젯 IIFE 번들링 |
| **데이터베이스** | Aurora MySQL (Cloudflare Hyperdrive 경유) | 메타데이터 저장 |
| **벡터 DB** | Cloudflare Vectorize | 1024차원, 코사인 유사도 |
| **KV 캐시** | Cloudflare KV | 세션 캐시 24시간 TTL |
| **오브젝트 스토리지** | Cloudflare R2 | 파일 저장 (예약) |
| **AI 모델 (채팅)** | `@cf/google/gemma-3-12b-it` | RAG 기반 응답 생성 |
| **AI 모델 (학습/퀴즈)** | `@cf/google/gemma-3-12b-it` | 메타데이터/퀴즈 생성 |
| **임베딩 모델** | `@cf/baai/bge-m3` | 1024차원 벡터 변환 (다국어) |
| **AI Gateway** | Cloudflare AI Gateway | 캐시 3600s, 모니터링 |
| **API 문서** | Swagger UI (`@hono/swagger-ui`) | 자동 API 문서 |
| **인증** | Bearer 토큰 (API Key) | 단순 API 키 인증 |
| **호스팅 (Frontend)** | Cloudflare Pages | 정적 파일 호스팅 |
| **호스팅 (Backend)** | Cloudflare Workers | 서버리스 API |
| **PDF 처리** | unpdf, pdf-parse | PDF 텍스트 추출 |
| **JWT** | jose | JWT 처리 라이브러리 (선택적) |

---

## Cloudflare 서비스

### 사용하는 Cloudflare 서비스

| 서비스 | 역할 | 설명 |
|--------|------|------|
| **Workers** | Backend API 서버 | 전 세계 엣지에서 실행되는 서버리스 런타임 |
| **Pages** | Frontend 호스팅 | 정적 파일 호스팅 + CDN, 테넌트별 별도 프로젝트 배포 |
| **Workers AI** | AI 모델 실행 | LLM, 임베딩 모델을 Workers에서 직접 호출 |
| **AI Gateway** | AI 트래픽 관리 | 요청 캐싱 (3600s), 속도 제한, 모니터링 |
| **Vectorize** | 벡터 데이터베이스 | 1024차원 코사인 유사도 검색 |
| **Hyperdrive** | DB 커넥션 풀 | Aurora MySQL 연결 가속/풀링 |
| **R2** | 파일 저장소 | S3 호환 오브젝트 스토리지 (예약) |
| **KV** | 캐시 저장소 | 키-값 저장소, 세션 캐시 (24h TTL) |

### Workers 바인딩 구조

```toml
# wrangler.toml에서 설정
[ai]
binding = "AI"
gateway = { id = "malgn-chatbot", cache_ttl = 3600 }

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-config-id>"

[[kv_namespaces]]
binding = "KV"

[[r2_buckets]]
binding = "BUCKET"

[[vectorize]]
binding = "VECTORIZE"
```

코드에서 `env.AI`, `env.HYPERDRIVE`, `env.KV`, `env.BUCKET`, `env.VECTORIZE`로 접근합니다.
DB 쿼리는 `env.HYPERDRIVE.connectionString`을 사용해 MySQL 클라이언트로 연결합니다.

---

## RAG란 무엇인가?

**RAG (Retrieval-Augmented Generation)** = 검색 증강 생성

등록된 학습 자료만을 근거로 AI가 대답하게 만드는 기법입니다.

### 왜 RAG가 필요한가?

일반 LLM의 한계:
- 학습되지 않은 최신/전문 정보를 모름
- 가끔 틀린 정보를 생성 (할루시네이션)
- 특정 도메인 자료에 대한 정확한 답변 불가

RAG의 해결책:
- 우리가 등록한 문서를 벡터 DB에 저장
- 질문 시 관련 문서를 먼저 검색
- 검색된 문서를 LLM에게 참고 자료로 제공

### RAG 작동 원리 (이 프로젝트 기준)

#### Step 1: 콘텐츠 등록 (준비 단계)

```
1. 콘텐츠 등록 (텍스트/PDF/SRT/VTT/링크)
       ↓
2. 텍스트 추출 (PDF: unpdf, SRT/VTT: 정규식 파싱)
       ↓
3. 청크 분할 (500자 단위, 100자 오버랩, 문장 경계)
       ↓
4. 임베딩 생성 (bge-m3 → 1024차원 벡터)
       ↓
5. Vectorize에 저장 (ID: content-{id}-chunk-{n})
       ↓
6. [백그라운드] 퀴즈 자동 생성 (Gemma 3 12B)
```

#### Step 2: 질의응답 (실행 단계)

```
1. 사용자 질문: "환불 정책이 어떻게 되나요?"
       ↓
2. 질문을 1024차원 벡터로 변환
       ↓
3. Vectorize에서 유사 문서 검색 (top 5, 유사도 0.5 이상)
       ↓
4. XML 태그 구조의 시스템 프롬프트 구축
   <role> + <learning_context> + <rules> + <reference_documents>
       ↓
5. Gemma 3 12B로 응답 생성 (AI Gateway 경유, 캐시 3600s)
       ↓
6. 응답 저장 (TB_MESSAGE) 및 반환
```

---

## 사용 기술 상세

### Backend

#### Hono (웹 프레임워크)

Express.js와 비슷하지만 더 가볍고 Cloudflare Workers에 최적화된 프레임워크입니다.

```javascript
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors());

// 라우트 등록
app.route('/chat', chatRoutes);
app.route('/sessions', sessionRoutes);
app.route('/contents', contentRoutes);
```

#### Workers AI (AI 모델)

Workers에서 직접 AI 모델을 호출합니다. AI Gateway를 경유하여 캐싱/모니터링됩니다.

```javascript
// 채팅용 LLM (Gemma 3 12B — 다국어/추론 균형)
const response = await env.AI.run('@cf/google/gemma-3-12b-it', {
  messages: [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ]
});

// 학습/퀴즈 생성용 LLM (동일 모델 사용)
const result = await env.AI.run('@cf/google/gemma-3-12b-it', {
  messages: [{ role: 'system', content: prompt }]
});

// 임베딩 생성 (다국어)
const { data } = await env.AI.run('@cf/baai/bge-m3', {
  text: ['변환할 텍스트']
});
// data[0] = [0.1, 0.2, ...] (1024차원 벡터)
```

#### Vectorize (벡터 데이터베이스)

텍스트 임베딩 벡터를 저장하고 코사인 유사도로 검색합니다.

```javascript
// 벡터 저장
await env.VECTORIZE.insert([{
  id: 'content-1-chunk-0',
  values: embedding,  // 1024차원 벡터
  metadata: { type: 'content', contentId: 1, contentTitle: '환불 정책' }
}]);

// 유사 벡터 검색
const results = await env.VECTORIZE.query(queryVector, {
  topK: 5,
  returnMetadata: "all"
});
```

#### Aurora MySQL (Hyperdrive 경유)

```javascript
// MySQL 클라이언트로 Hyperdrive connection string 사용
import { createConnection } from 'mysql2/promise';

const conn = await createConnection(env.HYPERDRIVE.connectionString);

// 데이터 조회 (status 필터 필수)
const [contents] = await conn.execute(
  'SELECT * FROM TB_CONTENT WHERE status = 1 ORDER BY created_at DESC'
);

// 데이터 삽입
await conn.execute(
  'INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, content) VALUES (?, ?, ?, ?, ?)',
  [name, filename, fileType, fileSize, text]
);
```

#### Swagger UI (API 문서)

`@hono/swagger-ui`를 사용하여 자동 API 문서를 제공합니다.

- `GET /docs` — Swagger UI 인터페이스
- `GET /openapi.json` — OpenAPI 3.0 스펙 (JSON)

### Frontend

#### Vanilla JavaScript 싱글톤 모듈 패턴

프레임워크 없이 순수 JavaScript의 모듈 패턴을 사용합니다.

```javascript
// 싱글톤 모듈 패턴 (관리자 대시보드)
const Sessions = {
  init() {
    this.bindEvents();
    this.loadSessions();
  },
  bindEvents() { /* ... */ },
  loadSessions() { /* ... */ }
};
```

#### esbuild (임베드 위젯 번들링)

임베드 위젯 소스(ES6 모듈)를 단일 IIFE 파일로 번들링합니다.

```bash
# 빌드 명령어
npm run build
# js/embed/*.js → js/chatbot-embed.js (IIFE)
```

#### SSE 스트리밍

실시간 토큰 스트리밍을 위해 Server-Sent Events를 사용합니다.

```javascript
// 프론트엔드 SSE 수신
const response = await fetch('/chat/stream', { method: 'POST', body: JSON.stringify({...}) });
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value);
  // SSE 이벤트 파싱 및 표시
}
```

---

## 용어 설명

| 용어 | 영문 | 설명 |
|------|------|------|
| 임베딩 | Embedding | 텍스트를 고정 길이 숫자 배열(벡터)로 변환하는 것 |
| 벡터 | Vector | 숫자들의 배열 (이 프로젝트: 1024차원) |
| 청크 | Chunk | 긴 문서를 작은 조각으로 나눈 것 (500자, 100자 오버랩) |
| LLM | Large Language Model | 대규모 언어 모델 (Gemma, GPT 등) |
| RAG | Retrieval-Augmented Generation | 검색 증강 생성 — 문서 기반 AI 응답 |
| SSE | Server-Sent Events | 서버→클라이언트 단방향 실시간 스트리밍 |
| 토큰 | Token | AI가 처리하는 텍스트 단위 |
| 프롬프트 | Prompt | AI에게 주는 지시문/질문 |
| 컨텍스트 | Context | AI에게 제공하는 배경 정보 (RAG 검색 결과) |
| 페르소나 | Persona | AI의 역할/성격을 정의하는 시스템 프롬프트 |
| Soft Delete | Soft Delete | 물리 삭제 대신 status=-1로 비활성화 |
| 멀티테넌트 | Multi-tenant | 하나의 코드베이스로 복수 기관 운영 |
| AI Gateway | AI Gateway | AI 요청 캐싱/모니터링/속도제한 프록시 |

---

## 참고 자료

### 공식 문서
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/)
- [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- [AWS RDS Aurora MySQL](https://aws.amazon.com/rds/aurora/)
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)
- [Hono 공식 문서](https://hono.dev/)
- [esbuild](https://esbuild.github.io/)

---

## 다음 단계

- [API 명세서](./API_SPECIFICATION.md) - API 엔드포인트 상세
- [데이터베이스 스키마](./DATABASE_SCHEMA.md) - DB 구조
- [개발 가이드](./DEVLOPMENT_GUIDE.md) - 코딩 컨벤션 및 패턴
