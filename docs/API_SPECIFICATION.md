# API 명세서 (API Specification)

이 문서는 AI 튜터 챗봇 Backend API의 모든 엔드포인트를 설명합니다.

---

## 기본 정보

| 항목 | 값 |
|------|-----|
| Base URL (개발) | `http://localhost:8787` |
| Base URL (user1) | `https://malgn-chatbot-api-user1.<account>.workers.dev` |
| Base URL (cloud) | `https://malgn-chatbot-api-cloud.<account>.workers.dev` |
| 응답 형식 | JSON |
| 인증 | Bearer 토큰 (`Authorization: Bearer {API_KEY}`) |
| API 문서 | `GET /docs` (Swagger UI) |

### 인증

보호 경로(`/chat/*`, `/contents/*`, `/sessions/*`)에는 Bearer 토큰 인증이 필요합니다.

```http
Authorization: Bearer your-api-key-here
```

인증 실패 시:
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "인증이 필요합니다."
  }
}
```

---

## 목차

1. [일반 API](#1-일반-api)
2. [채팅 API](#2-채팅-api)
3. [세션 관리 API](#3-세션-관리-api)
4. [콘텐츠 관리 API](#4-콘텐츠-관리-api)
5. [에러 코드](#5-에러-코드)
6. [CORS 설정](#6-cors-설정)

---

## 1. 일반 API

### GET /

API 문서 페이지로 리다이렉트합니다.

```http
GET /
→ 302 Redirect to /docs
```

### GET /health

서버 상태를 확인합니다.

**응답:**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-25T12:00:00.000Z"
}
```

### GET /openapi.json

OpenAPI 3.0 스펙을 반환합니다.

### GET /docs

Swagger UI 문서 페이지를 반환합니다.

---

## 2. 채팅 API

### POST /chat

사용자 메시지를 받아 RAG 파이프라인을 통해 AI 응답을 생성합니다 (동기).

**요청:**
```http
POST /chat
Content-Type: application/json
Authorization: Bearer {API_KEY}
```

**Body:**
```json
{
  "message": "이 강의의 핵심 내용이 뭔가요?",
  "sessionId": 28,
  "settings": {
    "persona": "당신은 친절한 AI 튜터입니다.",
    "temperature": 0.3,
    "topP": 0.3,
    "maxTokens": 1024
  }
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| message | string | O | 사용자 질문 (최대 10,000자) |
| sessionId | number | X | 세션 ID (대화 기록 유지용) |
| settings | object | X | AI 설정 |
| settings.persona | string | X | AI 페르소나 (시스템 프롬프트) |
| settings.temperature | number | X | 창의성 (0~1, 기본값: 0.3) |
| settings.topP | number | X | 다양성 (0.1~1, 기본값: 0.3) |
| settings.maxTokens | number | X | 최대 응답 길이 (256~4096, 기본값: 1024) |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "response": "이 강의의 핵심 내용은...",
    "sources": [
      {
        "contentId": 5,
        "title": "강의 요약 자료",
        "score": 0.87
      }
    ],
    "sessionId": 28
  }
}
```

**curl 예제:**
```bash
curl -X POST http://localhost:8787/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"message": "핵심 내용을 요약해줘", "sessionId": 28}'
```

---

### POST /chat/stream

SSE(Server-Sent Events) 스트리밍 방식으로 AI 응답을 생성합니다.

**요청:** `POST /chat`과 동일

**SSE 이벤트:**

| 이벤트 | 데이터 | 설명 |
|--------|--------|------|
| `token` | `{"response": "토큰 텍스트"}` | 실시간 토큰 스트리밍 |
| `done` | `{"sources": [...], "sessionId": 28}` | 응답 완료 |
| `error` | `{"message": "오류 메시지"}` | 오류 발생 |

**curl 예제:**
```bash
curl -X POST http://localhost:8787/chat/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"message": "핵심 내용을 요약해줘", "sessionId": 28}'
```

---

## 3. 세션 관리 API

### GET /sessions

세션 목록을 조회합니다 (부모 세션만, `parent_id = 0`).

**Query Parameters:**

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| page | number | X | 페이지 번호 (기본값: 1) |
| limit | number | X | 페이지당 개수 (기본값: 50, 최대: 100) |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "sessions": [
      {
        "id": 28,
        "title": "Python 기초 학습",
        "lastMessage": "변수란 데이터를 저장하는 공간입니다...",
        "messageCount": 12,
        "created_at": "2026-02-23T10:00:00Z",
        "updated_at": "2026-02-23T15:30:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 5,
      "totalPages": 1
    }
  }
}
```

---

### POST /sessions

새 세션을 생성합니다 (부모 또는 자식).

**Body (부모 세션 생성):**
```json
{
  "content_ids": [1, 2, 3],
  "settings": {
    "persona": "당신은 친절한 AI 튜터입니다.",
    "temperature": 0.3,
    "topP": 0.3,
    "maxTokens": 1024,
    "summaryCount": 3,
    "recommendCount": 3,
    "quizCount": 5
  }
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| content_ids | number[] | O (부모) | 연결할 콘텐츠 ID 배열 (최소 1개) |
| parent_id | number | X | 부모 세션 ID (> 0이면 자식 세션 생성) |
| course_id | number | X | LMS 코스 ID |
| course_user_id | number | X | LMS 수강생 ID |
| lesson_id | number | X | LMS 레슨 ID |
| user_id | number | X | 사용자 ID |
| settings | object | X | AI 설정 |

**Body (자식 세션 생성):**
```json
{
  "parent_id": 28,
  "course_user_id": 101,
  "course_id": 1,
  "lesson_id": 5
}
```

**자식 세션 생성 로직:**
1. 부모 세션 존재 확인 (`parent_id = 0 AND status = 1`)
2. 동일 `parent_id + course_user_id` 자식 존재 시 → 기존 자식 반환 (200)
3. 미존재 시 → 부모 설정 복사하여 새 자식 생성 (201)

**성공 응답 (201 - 부모 세션):**
```json
{
  "success": true,
  "data": {
    "session": { "id": 28, "parentId": 0 },
    "id": 28,
    "parentId": 0,
    "userId": null,
    "title": "Python 기초 학습",
    "settings": {
      "persona": "당신은 친절한 AI 튜터입니다.",
      "temperature": 0.3,
      "topP": 0.3,
      "maxTokens": 1024,
      "summaryCount": 3,
      "recommendCount": 3,
      "quizCount": 5
    },
    "learning": {
      "goal": "Python 기초 문법과 프로그래밍 개념을 이해합니다.",
      "summary": ["변수와 자료형", "조건문과 반복문", "함수 정의와 활용"],
      "recommendedQuestions": ["변수란 무엇인가요?", "for문과 while문의 차이는?"]
    },
    "contents": [
      { "id": 1, "content_nm": "Python 기초 교재" }
    ],
    "messages": [],
    "messageCount": 0,
    "created_at": "2026-02-23T10:00:00Z",
    "updated_at": "2026-02-23T10:00:00Z"
  },
  "message": "새 세션이 생성되었습니다."
}
```

**성공 응답 (200 - 기존 자식 세션 반환):**
```json
{
  "success": true,
  "data": {
    "session": { "id": 31, "parentId": 28 },
    "id": 31,
    "parentId": 28,
    "userId": null,
    "title": "Python 기초 학습",
    "settings": { "..." },
    "learning": {
      "goal": "부모의 학습 목표",
      "summary": ["부모의 핵심 요약"],
      "recommendedQuestions": ["부모의 추천 질문"]
    },
    "contents": [{ "id": 1, "content_nm": "Python 기초 교재" }],
    "messages": [
      { "id": 100, "role": "user", "content": "이전 질문", "created_at": "..." },
      { "id": 101, "role": "assistant", "content": "이전 답변", "created_at": "..." }
    ],
    "messageCount": 2,
    "created_at": "2026-02-23T11:00:00Z",
    "updated_at": "2026-02-23T11:30:00Z"
  }
}
```

---

### GET /sessions/:id

세션 상세 정보를 조회합니다 (메시지, 콘텐츠, 학습데이터 포함).

자식 세션(`parent_id > 0`)의 경우 부모의 콘텐츠/학습데이터를 사용하고, 메시지는 자식 자체의 기록을 반환합니다.

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "id": 31,
    "parentId": 28,
    "userId": null,
    "title": "Python 기초 학습",
    "settings": {
      "persona": "...",
      "temperature": 0.3,
      "topP": 0.3,
      "maxTokens": 1024,
      "summaryCount": 3,
      "recommendCount": 3,
      "quizCount": 5
    },
    "learning": {
      "goal": "학습 목표 텍스트",
      "summary": ["요약1", "요약2", "요약3"],
      "recommendedQuestions": ["질문1", "질문2", "질문3"]
    },
    "contents": [
      { "id": 1, "content_nm": "콘텐츠 제목" }
    ],
    "messages": [
      { "id": 100, "role": "user", "content": "질문", "created_at": "..." },
      { "id": 101, "role": "assistant", "content": "답변", "created_at": "..." }
    ],
    "messageCount": 2,
    "created_at": "2026-02-23T11:00:00Z",
    "updated_at": "2026-02-23T11:30:00Z"
  }
}
```

---

### PUT /sessions/:id

세션의 AI 설정을 업데이트합니다.

**Body:**
```json
{
  "settings": {
    "persona": "새로운 페르소나",
    "temperature": 0.5,
    "topP": 0.5,
    "maxTokens": 2048,
    "summaryCount": 5,
    "recommendCount": 5,
    "quizCount": 10
  }
}
```

| 필드 | 타입 | 범위 | 기본값 |
|------|------|------|--------|
| settings.persona | string | - | 기존 값 유지 |
| settings.temperature | number | 0~1 | 기존 값 유지 |
| settings.topP | number | 0.1~1 | 기존 값 유지 |
| settings.maxTokens | number | 256~4096 | 기존 값 유지 |
| settings.summaryCount | number | 1~10 | 기존 값 유지 |
| settings.recommendCount | number | 1~10 | 기존 값 유지 |
| settings.quizCount | number | 1~20 | 기존 값 유지 |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "id": 28,
    "settings": {
      "persona": "새로운 페르소나",
      "temperature": 0.5,
      "topP": 0.5,
      "maxTokens": 2048,
      "summaryCount": 5,
      "recommendCount": 5,
      "quizCount": 10
    }
  },
  "message": "AI 설정이 업데이트되었습니다."
}
```

---

### DELETE /sessions/:id

세션을 삭제합니다 (soft delete).

부모 세션 삭제 시 자식 세션도 연쇄 삭제됩니다.

**삭제 범위:**
- 세션 (`TB_SESSION.status = -1`)
- 메시지 (`TB_MESSAGE.status = -1`)
- 세션-콘텐츠 연결 (`TB_SESSION_CONTENT.status = -1`)
- Vectorize 학습 임베딩 삭제
- 부모 삭제 시: 모든 자식 세션 + 메시지도 soft delete

**성공 응답 (200):**
```json
{
  "success": true,
  "message": "세션이 성공적으로 삭제되었습니다."
}
```

---

### GET /sessions/:id/quizzes

세션에 연결된 콘텐츠의 퀴즈를 조회합니다.

자식 세션이면 부모의 콘텐츠로 퀴즈를 조회합니다.

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "sessionId": 28,
    "quizzes": [
      {
        "id": 1,
        "contentId": 5,
        "quizType": "choice",
        "question": "Python에서 변수를 선언하는 올바른 방법은?",
        "options": ["var x = 1", "x = 1", "int x = 1", "let x = 1"],
        "answer": "2",
        "explanation": "Python은 타입 선언 없이 변수를 할당합니다."
      },
      {
        "id": 2,
        "contentId": 5,
        "quizType": "ox",
        "question": "Python은 컴파일 언어이다.",
        "options": null,
        "answer": "X",
        "explanation": "Python은 인터프리터 언어입니다."
      }
    ],
    "total": 2
  }
}
```

---

### POST /sessions/:id/quizzes

세션에 연결된 콘텐츠의 퀴즈를 재생성합니다.

**Body (선택):**
```json
{
  "choiceCount": 3,
  "oxCount": 2
}
```

| 필드 | 타입 | 설명 | 기본값 |
|------|------|------|--------|
| choiceCount | number | 4지선다 퀴즈 수 (0~10) | 3 |
| oxCount | number | OX 퀴즈 수 (0~10) | 2 |
| count | number | 하위 호환: 총 퀴즈 수 (자동 분배) | - |

**성공 응답 (201):**
```json
{
  "success": true,
  "data": {
    "sessionId": 28,
    "quizzes": [...],
    "total": 5
  },
  "message": "5개의 퀴즈가 재생성되었습니다."
}
```

---

## 4. 콘텐츠 관리 API

### GET /contents

콘텐츠 목록을 조회합니다.

**Query Parameters:**

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| page | number | X | 페이지 번호 (기본값: 1) |
| limit | number | X | 페이지당 개수 (기본값: 20, 최대: 100) |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "contents": [
      {
        "id": 5,
        "content_nm": "Python 기초 교재",
        "filename": "python_basics.pdf",
        "file_type": "pdf",
        "file_size": 102400,
        "status": 1,
        "created_at": "2026-02-20T10:00:00Z",
        "updated_at": "2026-02-20T10:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5,
      "totalPages": 1
    }
  }
}
```

---

### POST /contents

새 콘텐츠를 등록합니다.

#### 텍스트 등록

```http
POST /contents
Content-Type: application/json
Authorization: Bearer {API_KEY}
```

```json
{
  "type": "text",
  "title": "학습 내용 요약",
  "content": "Python은 인터프리터 언어로..."
}
```

#### 링크 등록

```json
{
  "type": "link",
  "title": "강의 자막",
  "url": "https://example.com/subtitle.srt"
}
```

지원 URL: HTML 페이지, TXT, SRT, VTT 자막 파일

#### 파일 업로드

```http
POST /contents
Content-Type: multipart/form-data
Authorization: Bearer {API_KEY}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| file | file | O | 업로드할 파일 |
| title | string | X | 콘텐츠 제목 (미입력 시 파일명 사용) |

**지원 파일 형식:**

| 형식 | 확장자 | 최대 크기 |
|------|--------|----------|
| PDF | .pdf | 10MB |
| 텍스트 | .txt | 10MB |
| 마크다운 | .md | 10MB |
| SRT 자막 | .srt | 10MB |
| WebVTT 자막 | .vtt | 10MB |

**성공 응답 (201):**
```json
{
  "success": true,
  "data": {
    "id": 6,
    "content_nm": "학습 내용 요약",
    "filename": "학습 내용 요약",
    "file_type": "text",
    "file_size": 1024,
    "status": 1,
    "created_at": "2026-02-25T10:00:00Z"
  },
  "message": "텍스트가 성공적으로 추가되었습니다."
}
```

**처리 파이프라인:** 텍스트 추출 → DB 저장 → 청크 분할 (500자/100자 오버랩) → 임베딩 생성 → Vectorize 저장 → (백그라운드) 퀴즈 생성

**curl 예제:**
```bash
# 텍스트
curl -X POST http://localhost:8787/contents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"type": "text", "title": "학습 자료", "content": "내용..."}'

# 파일
curl -X POST http://localhost:8787/contents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@./document.pdf" \
  -F "title=PDF 교재"

# 링크
curl -X POST http://localhost:8787/contents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"type": "link", "title": "강의 자막", "url": "https://example.com/sub.srt"}'
```

---

### GET /contents/:id

콘텐츠 상세 정보를 조회합니다.

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "id": 5,
    "content_nm": "Python 기초 교재",
    "filename": "python_basics.pdf",
    "file_type": "pdf",
    "file_size": 102400,
    "content": "전체 텍스트 내용...",
    "status": 1,
    "created_at": "2026-02-20T10:00:00Z",
    "updated_at": "2026-02-20T10:00:00Z"
  }
}
```

---

### PUT /contents/:id

콘텐츠를 수정합니다 (제목 및 내용).

**Body:**
```json
{
  "title": "수정된 제목",
  "content": "수정된 내용"
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| title | string | O | 콘텐츠 제목 |
| content | string | X | 콘텐츠 내용 |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "id": 5,
    "content_nm": "수정된 제목",
    "updated_at": "2026-02-25T12:00:00Z"
  },
  "message": "콘텐츠가 성공적으로 수정되었습니다."
}
```

---

### DELETE /contents/:id

콘텐츠를 삭제합니다 (soft delete, `status = -1`).

**성공 응답 (200):**
```json
{
  "success": true,
  "message": "콘텐츠가 성공적으로 삭제되었습니다."
}
```

---

### GET /contents/:id/quizzes

특정 콘텐츠의 퀴즈 목록을 조회합니다.

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "contentId": 5,
    "quizCount": 5,
    "quizzes": [
      {
        "id": 1,
        "quiz_type": "choice",
        "question": "질문 텍스트",
        "options": ["보기1", "보기2", "보기3", "보기4"],
        "answer": "1",
        "explanation": "해설 텍스트",
        "position": 0
      }
    ]
  }
}
```

---

### POST /contents/:id/quizzes

특정 콘텐츠의 퀴즈를 재생성합니다.

**Body (선택):**
```json
{
  "choiceCount": 3,
  "oxCount": 2
}
```

| 필드 | 타입 | 설명 | 기본값 |
|------|------|------|--------|
| choiceCount | number | 4지선다 퀴즈 수 (0~10) | 3 |
| oxCount | number | OX 퀴즈 수 (0~10) | 2 |
| count | number | 하위 호환: 총 퀴즈 수 | - |

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "contentId": 5,
    "quizCount": 5,
    "quizzes": [...]
  },
  "message": "5개의 퀴즈가 생성되었습니다."
}
```

---

### POST /contents/regenerate-all-quizzes

모든 콘텐츠에 대해 퀴즈를 재생성합니다 (퀴즈가 없는 콘텐츠만).

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "processed": 3,
    "results": [...]
  }
}
```

---

### POST /contents/reembed

모든 콘텐츠를 Vectorize에 재임베딩합니다 (인덱스 재생성 후 사용).

**성공 응답 (200):**
```json
{
  "success": true,
  "data": {
    "processed": 5,
    "results": [...]
  }
}
```

---

## 5. 에러 코드

### HTTP 상태 코드

| 코드 | 의미 | 설명 |
|------|------|------|
| 200 | OK | 요청 성공 |
| 201 | Created | 리소스 생성 성공 |
| 400 | Bad Request | 잘못된 요청 (파라미터 오류 등) |
| 401 | Unauthorized | 인증 실패 (API Key 없음/불일치) |
| 404 | Not Found | 리소스를 찾을 수 없음 |
| 413 | Payload Too Large | 파일 크기 초과 (10MB) |
| 415 | Unsupported Media Type | 지원하지 않는 파일 형식 |
| 500 | Internal Server Error | 서버 내부 오류 |

### 에러 응답 형식

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "message 필드는 필수입니다.",
    "detail": "선택적 상세 정보"
  }
}
```

### 에러 코드 목록

| 코드 | 설명 |
|------|------|
| UNAUTHORIZED | 인증 실패 |
| VALIDATION_ERROR | 입력값 검증 실패 |
| NOT_FOUND | 리소스 없음 |
| NO_CONTENT | 연결된 학습 콘텐츠 없음 |
| FILE_TOO_LARGE | 파일 크기 초과 |
| UNSUPPORTED_FILE_TYPE | 지원하지 않는 파일 형식 |
| URL_ERROR | URL 접근/처리 오류 |
| EXTRACTION_ERROR | 텍스트 추출 실패 |
| EMBEDDING_ERROR | 임베딩 생성 실패 |
| AI_ERROR | AI 응답 생성 실패 |
| INTERNAL_ERROR | 내부 서버 오류 |

---

## 6. CORS 설정

모든 API는 CORS가 활성화되어 있습니다.

| 항목 | 값 |
|------|-----|
| 허용 출처 | `*` (전체) |
| 허용 메서드 | GET, POST, PUT, DELETE, OPTIONS |
| 허용 헤더 | Content-Type, Authorization |
