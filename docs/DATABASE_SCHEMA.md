# 데이터베이스 스키마 (Database Schema)

이 문서는 Malgn Chatbot 프로젝트의 데이터베이스 구조를 설명합니다.

---

## 개요

| 데이터베이스 | 용도 | 저장 데이터 |
|-------------|------|------------|
| **D1** (SQLite) | 메타데이터 저장 | 콘텐츠, 세션, 메시지, 퀴즈 |
| **Vectorize** | 벡터 저장/검색 | 콘텐츠 청크 임베딩 (768차원) |
| **KV** | 캐시 | 세션 데이터 캐시 (24시간 TTL) |
| **R2** | 파일 저장 | 업로드 원본 파일 (예약) |

---

## D1 (SQLite) 스키마

### 공통 패턴

- **status 컬럼**: 모든 테이블에 존재 — `1`(정상), `0`(중지), `-1`(삭제)
- **Soft Delete**: 물리 삭제 금지, `status = -1`로 변경
- **조회 시**: 모든 SELECT에 `WHERE status = 1` 필수

### 테이블 관계도

```
TB_CONTENT ──────────── TB_QUIZ
   │ 1:N                  │ content_id (FK)
   │                      │
   │            TB_SESSION_CONTENT
   │              │ content_id (FK)
   │              │ session_id (FK)
   │              │
   │            TB_SESSION ──────── TB_MESSAGE
   │              │ 1:N              │ session_id (FK)
   │              │
   │              │ parent_id (자기참조)
   │              ├── 교수자 세션 (parent_id = 0)
   │              └── 학습자 세션 (parent_id > 0)
```

### 1. TB_CONTENT — 학습 콘텐츠

학습 자료의 메타데이터와 전체 텍스트를 저장합니다.

```sql
CREATE TABLE IF NOT EXISTS TB_CONTENT (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_nm TEXT NOT NULL,         -- 콘텐츠 제목
  filename TEXT NOT NULL,           -- 원본 파일명
  file_type TEXT NOT NULL,          -- 파일 유형 (pdf, txt, md, srt, vtt, link, text)
  file_size INTEGER NOT NULL,       -- 파일 크기 (bytes)
  content TEXT,                     -- 추출된 전체 텍스트
  lesson_id INTEGER,               -- LMS 차시 ID (선택)
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

| 컬럼 | 타입 | 설명 | 예시 |
|------|------|------|------|
| id | INTEGER | 자동 증가 PK | `1`, `2`, `3` |
| content_nm | TEXT | 콘텐츠 제목 | `환불 정책 안내` |
| filename | TEXT | 원본 파일명 | `refund_policy.pdf` |
| file_type | TEXT | 파일 유형 | `pdf`, `txt`, `md`, `srt`, `vtt`, `link`, `text` |
| file_size | INTEGER | 바이트 크기 | `102400` |
| content | TEXT | 추출 전문 (nullable) | `환불은 구매 후 7일 이내...` |
| lesson_id | INTEGER | LMS 차시 ID (nullable) | `1`, `null` |

**인덱스**: `idx_content_created_at`, `idx_content_status`, `idx_content_lesson_id`

### 2. TB_SESSION — 채팅 세션

채팅 세션 및 AI 설정을 저장합니다. 부모-자식 관계를 지원합니다.

```sql
CREATE TABLE IF NOT EXISTS TB_SESSION (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER DEFAULT 0,         -- 0=부모(교수자), >0=자식(학습자)
  course_id INTEGER,                   -- LMS 과목 ID
  course_user_id INTEGER,              -- LMS 사용자 ID
  lesson_id INTEGER,                   -- LMS 차시 ID
  user_id INTEGER,                     -- 사용자 ID
  session_nm TEXT,                     -- 세션 제목 (AI 자동 생성)
  persona TEXT DEFAULT '...',          -- 시스템 프롬프트
  temperature REAL DEFAULT 0.3,        -- 응답 다양성 (0~1)
  top_p REAL DEFAULT 0.3,              -- 토큰 샘플링 범위 (0.1~1)
  max_tokens INTEGER DEFAULT 1024,     -- 최대 응답 길이 (256~4096)
  summary_count INTEGER DEFAULT 3,     -- 학습 요약 수
  recommend_count INTEGER DEFAULT 3,   -- 추천 질문 수
  quiz_count INTEGER DEFAULT 5,        -- 퀴즈 생성 수
  learning_goal TEXT,                  -- AI 생성 학습 목표
  learning_summary TEXT,               -- AI 생성 핵심 요약
  recommended_questions TEXT,          -- AI 생성 추천 질문
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

| 컬럼 | 타입 | 설명 |
|------|------|------|
| parent_id | INTEGER | `0`=교수자(부모) 세션, `>0`=학습자(자식) 세션의 부모 세션 ID |
| course_id | INTEGER | LMS 과목 식별자 |
| course_user_id | INTEGER | LMS 사용자 식별자 (자식 세션 중복 방지 키) |
| lesson_id | INTEGER | LMS 차시 식별자 |
| persona | TEXT | AI 튜터 시스템 프롬프트 |
| temperature | REAL | 0에 가까울수록 결정적, 1에 가까울수록 창의적 |
| top_p | REAL | 토큰 선택 확률 범위 |
| max_tokens | INTEGER | LLM 최대 응답 토큰 수 |
| summary_count | INTEGER | 학습 요약 생성 개수 |
| recommend_count | INTEGER | 추천 질문 생성 개수 |
| quiz_count | INTEGER | 퀴즈 생성 개수 (콘텐츠별) |
| learning_goal | TEXT | AI가 생성한 학습 목표 텍스트 |
| learning_summary | TEXT | AI가 생성한 핵심 요약 텍스트 |
| recommended_questions | TEXT | AI가 생성한 추천 질문 (JSON 배열) |

**인덱스**: `idx_session_status`, `idx_session_user`, `idx_session_parent_id`, `idx_session_parent_course_user`

### 3. TB_MESSAGE — 채팅 메시지

```sql
CREATE TABLE IF NOT EXISTS TB_MESSAGE (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,         -- 세션 FK
  user_id INTEGER,                     -- 사용자 ID
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,               -- 메시지 내용
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE
);
```

**인덱스**: `idx_message_session`, `idx_message_status`, `idx_message_user`

### 4. TB_SESSION_CONTENT — 세션-콘텐츠 매핑

세션에 연결된 학습 자료 범위를 설정합니다.

```sql
CREATE TABLE IF NOT EXISTS TB_SESSION_CONTENT (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  content_id INTEGER NOT NULL,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES TB_CONTENT(id) ON DELETE CASCADE,
  UNIQUE(session_id, content_id)       -- 중복 연결 방지
);
```

**인덱스**: `idx_session_content_session`, `idx_session_content_content`, `idx_session_content_status`

### 5. TB_QUIZ — 자동 생성 퀴즈

콘텐츠 기반으로 AI가 자동 생성한 퀴즈입니다.

```sql
CREATE TABLE IF NOT EXISTS TB_QUIZ (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL,         -- 콘텐츠 FK (콘텐츠 기반)
  quiz_type TEXT NOT NULL CHECK (quiz_type IN ('choice', 'ox')),
  question TEXT NOT NULL,              -- 문제
  options TEXT,                        -- 선택지 (JSON 배열, choice 타입만)
  answer TEXT NOT NULL,                -- 정답
  explanation TEXT,                    -- 해설
  position INTEGER NOT NULL,           -- 순서
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES TB_CONTENT(id) ON DELETE CASCADE
);
```

| quiz_type | 설명 | options 예시 | answer 예시 |
|-----------|------|-------------|-------------|
| `choice` | 4지선다 | `["A. ...", "B. ...", "C. ...", "D. ..."]` | `"A"` |
| `ox` | OX 퀴즈 | `null` | `"O"` 또는 `"X"` |

**인덱스**: `idx_quiz_content`, `idx_quiz_status`

---

## Vectorize 구조

Vectorize는 텍스트 임베딩 벡터를 저장하고 코사인 유사도 검색을 수행합니다.

### 인덱스 설정

| 항목 | 값 |
|------|-----|
| 인덱스 이름 | `malgn-chatbot-vectors` (테넌트별 분리) |
| 차원(Dimension) | 768 (`bge-base-en-v1.5` 모델 기준) |
| 거리 측정 | cosine (코사인 유사도) |

### 저장 데이터 유형

#### 콘텐츠 청크 벡터

```javascript
{
  id: "content-{contentId}-chunk-{index}",  // 청크별 고유 ID
  values: [0.1, 0.2, ...],                  // 768차원 벡터
  metadata: {
    type: "content",
    contentId: contentId,
    contentTitle: "환불 정책"
  }
}
```

#### 학습 목표 벡터

```javascript
{
  id: "session-{sessionId}-goal",
  values: [...],
  metadata: {
    type: "learning_goal",
    sessionId: sessionId,
    text: "환불 정책의 주요 조건을 이해한다"
  }
}
```

#### 학습 요약 벡터

```javascript
{
  id: "session-{sessionId}-summary",
  values: [...],
  metadata: {
    type: "learning_summary",
    sessionId: sessionId,
    text: "환불은 7일 이내 가능하며..."
  }
}
```

### 검색 예시

```javascript
// 쿼리 벡터로 상위 5개 유사 문서 검색
const results = await env.VECTORIZE.query(queryVector, {
  topK: 5,
  returnMetadata: "all"
});

// 결과: 유사도 0.5 이상만 사용
results.matches.filter(m => m.score >= 0.5);
```

---

## KV 구조

KV는 세션 데이터 캐시 용도로 사용합니다.

### 키 패턴

| 패턴 | 용도 | TTL |
|------|------|-----|
| `session:{sessionId}` | 세션 데이터 캐시 | 24시간 (86400초) |

### 사용 예시

```javascript
// 세션 캐시 저장
await env.KV.put(`session:${sessionId}`, JSON.stringify(sessionData), {
  expirationTtl: 86400  // 24시간
});

// 세션 캐시 조회
const cached = await env.KV.get(`session:${sessionId}`, { type: 'json' });

// 세션 캐시 무효화
await env.KV.delete(`session:${sessionId}`);
```

---

## R2 구조 (예약)

원본 파일 저장용으로 예약되어 있습니다.

### 버킷 명명 규칙

| 테넌트 | 버킷 이름 |
|--------|----------|
| dev / user1 | `malgn-chatbot-files` |
| user2 | `malgn-chatbot-files-user2` |

---

## 마이그레이션

### 전체 스키마 적용 (신규 DB)

```bash
wrangler d1 execute malgn-chatbot-db --file=./schema.sql
```

### 개별 마이그레이션

```bash
# 001: 퀴즈를 세션 기반 → 콘텐츠 기반으로 전환
wrangler d1 execute malgn-chatbot-db --file=./migrations/001_quiz_content_based.sql

# 002: 세션에 LMS 연동 필드 추가 (course_id, course_user_id, lesson_id)
wrangler d1 execute malgn-chatbot-db --file=./migrations/002_session_course_fields.sql

# 003: 부모-자식 세션 (parent_id)
wrangler d1 execute malgn-chatbot-db --file=./migrations/003_session_parent_id.sql

# 004: 콘텐츠에 lesson_id 추가 (LMS 차시별 분류)
wrangler d1 execute malgn-chatbot-db --file=./migrations/004_content_lesson_id.sql
```

### 테넌트별 마이그레이션

```bash
# user2 테넌트 (독립 DB)
wrangler d1 execute malgn-chatbot-db-user2 --file=./schema.sql --env user2
```

---

## 주의사항

### D1 제한사항
- 단일 쿼리 최대 실행 시간: 30초
- 단일 행 최대 크기: 1MB
- 모든 SELECT 쿼리에 `WHERE status = 1` 필수

### Vectorize 제한사항
- 벡터 차원: 768 (bge-base-en-v1.5 고정)
- 단일 쿼리 최대 결과: 20개
- 메타데이터 크기: 최대 10KB
- 유사도 임계값: 0.5 이상만 사용

### 최적화 팁
1. **청크 크기**: 500자 단위, 100자 오버랩, 문장 경계 기준
2. **인덱스**: 자주 검색하는 컬럼에 인덱스 추가 (status, session_id 등)
3. **배치 처리**: Vectorize insert/delete는 배열로 배치 처리

---

## 다음 단계

- [환경 설정 가이드](./SETUP_GUIDE.md) - Cloudflare 리소스 생성 방법
- [개발 가이드](./DEVLOPMENT_GUIDE.md) - DB 쿼리 규칙 및 패턴
