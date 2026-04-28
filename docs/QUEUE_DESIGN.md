# Cloudflare Queues 설계 문서

## 1. 배경

LMS에서 `POST /sessions/create-with-contents`를 **동시에 여러 개** 호출하여 세션을 일괄 생성합니다.
각 요청마다 콘텐츠 등록 + 학습데이터 생성 + 퀴즈 생성으로 **수십 초**가 걸리고,
동시 호출 시 LLM rate limit으로 **일부 실패**하는 문제가 있습니다.

### 현재 문제점

```
LMS에서 동시 5개 호출

POST /create-with-contents (A) ── 30초 대기 ── 성공
POST /create-with-contents (B) ── 30초 대기 ── 성공
POST /create-with-contents (C) ── 30초 대기 ── LLM 타임아웃 ❌
POST /create-with-contents (D) ── 30초 대기 ── rate limit ❌
POST /create-with-contents (E) ── 30초 대기 ── 일부 누락 ⚠️

문제:
- LMS도 수십 초 대기 (HTTP 타임아웃 위험)
- 동시 LLM 호출 15~20회 → rate limit
- 실패한 세션은 불완전 상태로 남음
```

---

## 2. Queue 적용 구조

```
LMS에서 동시 5개 호출 (각 0.5초 내 응답)

POST /create-with-contents (A) → 즉시 응답 { sessionId: 165, status: "pending" }
POST /create-with-contents (B) → 즉시 응답 { sessionId: 166, status: "pending" }
POST /create-with-contents (C) → 즉시 응답 { sessionId: 167, status: "pending" }
POST /create-with-contents (D) → 즉시 응답 { sessionId: 168, status: "pending" }
POST /create-with-contents (E) → 즉시 응답 { sessionId: 169, status: "pending" }

LMS 끝 ✅ (총 0.5초)


Queue Consumer (서버 백그라운드, 순차 처리)

A: 콘텐츠 등록 → 학습데이터 → 퀴즈 → completed → LMS 콜백
B: 콘텐츠 등록 → 학습데이터 → 퀴즈 → completed → LMS 콜백
C: 콘텐츠 등록 → 학습데이터 → 퀴즈 → completed → LMS 콜백
D: 콘텐츠 등록 → 학습데이터 → 퀴즈 → completed → LMS 콜백
E: 콘텐츠 등록 → 학습데이터 → 퀴즈 → completed → LMS 콜백

실패 시 자동 재시도 (최대 3회)
```

### 적용 대상

- **부모 세션 생성만 해당** (자식 세션은 부모 데이터 복사이므로 즉시 응답)
- `callbackUrl` 유무로 동기/비동기 자동 분기 → 기존 관리자 대시보드 영향 없음

---

## 3. 인프라 설정

### 3-1. Queue 생성

```bash
# 큐 생성
npx wrangler queues create malgn-chatbot-queue

# 테넌트별 분리
npx wrangler queues create malgn-chatbot-queue-user2

# (선택) Dead Letter Queue - 3회 실패 시 이동
npx wrangler queues create malgn-chatbot-dlq
```

### 3-2. wrangler.toml

```toml
# ── 기존 설정 아래에 추가 ──

# Cron Trigger (5분마다 비정상 상태 정리)
[triggers]
crons = ["*/5 * * * *"]

# Queue Producer (메시지 보내기)
[[queues.producers]]
queue = "malgn-chatbot-queue"
binding = "QUEUE"

# Queue Consumer (메시지 처리)
[[queues.consumers]]
queue = "malgn-chatbot-queue"
max_batch_size = 1              # 1개씩 처리 (LLM 호출이 무거움)
max_retries = 3                 # 실패 시 최대 3회 재시도
dead_letter_queue = "malgn-chatbot-dlq"  # 3회 실패 시 이동 (선택)

# ── user2 환경 ──
[env.user2]
[[env.user2.queues.producers]]
queue = "malgn-chatbot-queue-user2"
binding = "QUEUE"

[[env.user2.queues.consumers]]
queue = "malgn-chatbot-queue-user2"
max_batch_size = 1
max_retries = 3
```

### 3-3. DB 마이그레이션

```sql
-- TB_SESSION에 생성 상태 컬럼 추가
ALTER TABLE TB_SESSION ADD COLUMN generation_status TEXT DEFAULT 'none';

-- none       : 동기 생성 (기존 세션 호환)
-- pending    : 큐 대기 중
-- processing : 생성 중
-- completed  : 완료
-- failed     : 실패
```

실행:
```bash
npx wrangler d1 execute malgn-chatbot-db --file=./migrations/006_session_generation_status.sql
npx wrangler d1 execute malgn-chatbot-db-user2 --file=./migrations/006_session_generation_status.sql --env user2
```

---

## 4. API 변경

### 4-1. `POST /sessions/create-with-contents` 변경

`callbackUrl`이 있으면 Queue(비동기), 없으면 기존 동기 처리:

```js
sessions.post('/create-with-contents', async (c) => {
  const body = await c.req.json();
  const contents = body.contents || [];
  const settings = typeof body.settings === 'string' ? JSON.parse(body.settings) : (body.settings || {});
  const callbackUrl = body.callbackUrl || null;
  const callbackData = body.callbackData || null;
  const lessonId = body.lessonId || body.lesson_id || null;
  const courseId = body.courseId || body.course_id || null;
  const courseUserId = body.courseUserId || body.course_user_id || null;
  const userId = (body.userId ?? body.user_id) != null ? parseInt(body.userId ?? body.user_id, 10) : null;
  const sessionNm = body.sessionNm || body.session_nm || null;

  // ── 1단계: 콘텐츠 등록 (항상 동기, 빠름) ──
  const contentService = new ContentService(c.env, c.executionCtx);
  const contentResults = await Promise.all(
    contents.map(async (item) => {
      try {
        if (item.type === 'link' && item.url) {
          return await contentService.uploadLink(item.name || item.url, item.url, lessonId);
        } else if (item.type === 'text' && item.content) {
          return await contentService.uploadText(item.name || '텍스트', item.content, lessonId);
        }
        return { error: `지원하지 않는 콘텐츠 타입: ${item.type}` };
      } catch (err) {
        return { error: err.message, name: item.name || item.url };
      }
    })
  );

  const contentIds = contentResults.filter(r => r.id).map(r => r.id);
  const errors = contentResults.filter(r => r.error);

  if (contentIds.length === 0) {
    return c.json({
      success: false,
      error: { code: 'CONTENT_ERROR', message: '모든 콘텐츠 등록에 실패했습니다.', detail: errors }
    }, 400);
  }

  // ── 2단계: 세션 INSERT ──
  const useQueue = !!callbackUrl;
  const defaultPersona = '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변해 주세요.';

  const insertResult = await c.env.DB
    .prepare(`
      INSERT INTO TB_SESSION (parent_id, course_id, course_user_id, lesson_id, user_id, session_nm,
        persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count,
        quiz_difficulty, generation_status)
      VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      courseId, courseUserId, lessonId, userId, sessionNm,
      settings.persona || defaultPersona,
      settings.temperature ?? 0.3,
      settings.topP ?? 0.3,
      settings.maxTokens ?? 1024,
      settings.summaryCount ?? 3,
      settings.recommendCount ?? 3,
      settings.choiceCount ?? 3,
      settings.oxCount ?? 2,
      settings.quizDifficulty || 'normal',
      useQueue ? 'pending' : 'none'
    )
    .run();

  const sessionId = insertResult.meta.last_row_id;

  // 콘텐츠 연결
  for (const contentId of contentIds) {
    await c.env.DB
      .prepare('INSERT INTO TB_SESSION_CONTENT (session_id, content_id) VALUES (?, ?)')
      .bind(sessionId, contentId)
      .run();
  }

  // ── 3단계: Queue 또는 동기 처리 분기 ──
  if (useQueue) {
    // Queue에 메시지 전송 → 즉시 응답
    await c.env.QUEUE.send({
      type: 'session-generation',
      sessionId,
      contentIds,
      settings,
      callbackUrl,
      callbackData
    });

    return c.json({
      success: true,
      data: {
        sessionId,
        contentIds,
        generationStatus: 'pending',
        contentErrors: errors.length > 0 ? errors : undefined
      },
      message: '세션이 등록되었습니다. 생성 완료 시 콜백으로 알림합니다.'
    }, 202);  // 202 Accepted

  } else {
    // 기존 동기 처리 (관리자 대시보드용)
    // ... (현재 코드 유지) ...
  }
});
```

---

## 5. Queue Consumer 구현

### 5-1. `src/index.js` 수정

```js
import { Hono } from 'hono';
import { LearningService } from './services/learningService.js';
import { QuizService } from './services/quizService.js';

const app = new Hono();
// ... 기존 라우트 등록 ...

export default {
  // HTTP 요청 → Hono
  fetch: app.fetch,

  // Queue Consumer → 백그라운드 처리
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { type, sessionId, contentIds, settings, callbackUrl, callbackData } = msg.body;

      if (type !== 'session-generation') {
        msg.ack();
        continue;
      }

      // 이미 완료/삭제된 세션이면 스킵
      const session = await env.DB
        .prepare('SELECT generation_status, status FROM TB_SESSION WHERE id = ?')
        .bind(sessionId)
        .first();

      if (!session || session.status === -1 || session.generation_status === 'completed') {
        msg.ack();
        continue;
      }

      try {
        // ── 상태: processing ──
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('processing', sessionId)
          .run();

        // ── 학습 데이터 생성 ──
        const learningService = new LearningService(env);
        const learningData = await learningService.generateAndStoreLearningData(sessionId, contentIds, settings);

        // ── 퀴즈 생성 ──
        const quizService = new QuizService(env);
        const choiceCount = settings.choiceCount ?? 3;
        const oxCount = settings.oxCount ?? 2;

        if (choiceCount + oxCount > 0) {
          const contentTexts = [];
          for (const contentId of contentIds) {
            const content = await env.DB
              .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1')
              .bind(contentId)
              .first();
            if (content?.content?.trim().length >= 100) {
              contentTexts.push(content.content);
            }
          }
          const merged = contentTexts.join('\n\n---\n\n');
          if (merged.trim().length >= 100) {
            await quizService.generateQuizzesForContent(
              contentIds[0], merged,
              { choiceCount, oxCount, difficulty: settings.quizDifficulty || 'normal' },
              sessionId
            );
          }
        }

        // ── 상태: completed ──
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('completed', sessionId)
          .run();

        // ── LMS 콜백 (성공) ──
        if (callbackUrl) {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              generationStatus: 'completed',
              title: learningData.sessionNm,
              contentIds,
              learning: {
                goal: learningData.learningGoal,
                summaryCount: (learningData.learningSummary || []).length,
                recommendCount: (learningData.recommendedQuestions || []).length
              },
              quiz: { choiceCount, oxCount },
              callbackData
            })
          });
        }

        console.log(`[Queue] Session ${sessionId} completed`);

      } catch (error) {
        console.error(`[Queue] Session ${sessionId} failed:`, error.message);

        // ── 상태: failed ──
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('failed', sessionId)
          .run();

        // ── LMS 콜백 (실패) ──
        if (callbackUrl) {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              generationStatus: 'failed',
              error: error.message,
              contentIds,
              callbackData
            })
          }).catch(() => {});
        }

        msg.retry();  // 재시도 (max_retries까지)
        return;
      }

      msg.ack();  // 처리 완료
    }
  },

  // Cron Trigger → 비정상 상태 정리 (5분마다)
  async scheduled(event, env) {
    // 10분 넘게 processing → failed
    const r1 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'processing' AND updated_at < datetime('now', '-10 minutes')
    `).run();
    if (r1.meta.changes > 0) console.log(`[Cron] ${r1.meta.changes}개 processing → failed`);

    // 30분 넘게 pending → failed (큐 전달 실패)
    const r2 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'pending' AND updated_at < datetime('now', '-30 minutes')
    `).run();
    if (r2.meta.changes > 0) console.log(`[Cron] ${r2.meta.changes}개 pending → failed`);
  }
};
```

---

## 6. LMS 연동

### 6-1. LMS → 챗봇 (요청)

```json
POST /sessions/create-with-contents
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "contents": [
    { "type": "link", "url": "https://cdn.lms.com/subtitle.vtt", "name": "1과 자막" },
    { "type": "link", "url": "https://cdn.lms.com/lesson.pdf", "name": "1과 교안" }
  ],
  "settings": {
    "choiceCount": 3,
    "oxCount": 2,
    "quizDifficulty": "normal",
    "summaryCount": 3,
    "recommendCount": 3
  },
  "courseId": 100,
  "lessonId": 2942,
  "callbackUrl": "https://lms.example.com/api/chatbot/callback",
  "callbackData": {
    "courseId": 100,
    "lessonId": 2942,
    "semesterId": 55,
    "requestedBy": "admin01"
  }
}
```

### 6-2. 챗봇 → LMS (즉시 응답, 0.5초)

```json
HTTP 202 Accepted

{
  "success": true,
  "data": {
    "sessionId": 165,
    "contentIds": [50, 51],
    "generationStatus": "pending"
  },
  "message": "세션이 등록되었습니다. 생성 완료 시 콜백으로 알림합니다."
}
```

### 6-3. 챗봇 → LMS (완료 콜백)

```json
POST https://lms.example.com/api/chatbot/callback

{
  "sessionId": 165,
  "generationStatus": "completed",
  "title": "인사하기",
  "contentIds": [50, 51],
  "learning": {
    "goal": "기본 인사 표현을 배우고 활용할 수 있습니다.",
    "summaryCount": 3,
    "recommendCount": 3
  },
  "quiz": {
    "choiceCount": 3,
    "oxCount": 2
  },
  "callbackData": {
    "courseId": 100,
    "lessonId": 2942,
    "semesterId": 55,
    "requestedBy": "admin01"
  }
}
```

### 6-4. 챗봇 → LMS (실패 콜백)

```json
POST https://lms.example.com/api/chatbot/callback

{
  "sessionId": 165,
  "generationStatus": "failed",
  "error": "Quiz generation failed: model timeout",
  "contentIds": [50, 51],
  "callbackData": {
    "courseId": 100,
    "lessonId": 2942,
    "semesterId": 55,
    "requestedBy": "admin01"
  }
}
```

### 6-5. LMS 콜백 처리 예시 (Java/Spring)

```java
@PostMapping("/api/chatbot/callback")
public ResponseEntity<?> handleCallback(@RequestBody Map<String, Object> body) {
    String status = (String) body.get("generationStatus");
    Map<String, Object> callbackData = (Map<String, Object>) body.get("callbackData");

    int courseId = (int) callbackData.get("courseId");
    int lessonId = (int) callbackData.get("lessonId");

    if ("completed".equals(status)) {
        int sessionId = (int) body.get("sessionId");
        lessonService.updateChatbotSession(courseId, lessonId, sessionId);
    } else if ("failed".equals(status)) {
        String error = (String) body.get("error");
        logService.error("챗봇 세션 생성 실패: " + error);
    }

    return ResponseEntity.ok().build();
}
```

---

## 7. 상태 조회 API (선택)

콜백 외에 상태를 직접 조회하고 싶은 경우:

```
GET /sessions/165

응답:
{
  "id": 165,
  "generationStatus": "completed",
  "learning": { ... },
  ...
}
```

```
GET /sessions?generationStatus=pending,processing

응답: 현재 대기/처리 중인 세션 목록
```

---

## 8. 전체 아키텍처

```
┌─────────────────────────────────────────────────────┐
│ Worker (malgn-chatbot-api)                          │
│                                                     │
│  fetch()       ← HTTP 요청 (Hono 라우팅)            │
│  │                                                  │
│  ├── GET/POST /sessions, /contents, /chat           │
│  └── POST /create-with-contents                     │
│      ├── callbackUrl 있음 → Queue.send → 202        │
│      └── callbackUrl 없음 → 동기 처리 → 201         │
│                                                     │
│  queue()       ← Queue 메시지 처리 (백그라운드)      │
│  │                                                  │
│  └── 콘텐츠 등록 → 학습데이터 → 퀴즈 → 콜백         │
│                                                     │
│  scheduled()   ← Cron 5분마다 (상태 정리)            │
│  │                                                  │
│  └── processing/pending 타임아웃 → failed 처리       │
│                                                     │
├─────────────────────────────────────────────────────┤
│ Bindings                                            │
│  DB: D1                                             │
│  VECTORIZE: Vectorize                               │
│  AI: Workers AI                                     │
│  KV: KV Namespace                                   │
│  QUEUE: Cloudflare Queue                            │
└─────────────────────────────────────────────────────┘
```

---

## 9. 비용

| 항목 | 무료 범위 ($5 플랜) | 초과 시 |
|------|---------------------|--------|
| Queue 메시지 | 100만/월 | $0.40/100만 |
| Cron Trigger | 무제한 | 무료 |
| Workers AI | 일 10,000 neurons | $0.011/1,000 neurons |

세션 생성 1회 = Queue 메시지 1개 → 월 100만 세션까지 Queue 비용 무료

---

## 10. 구현 순서

1. DB 마이그레이션 (`generation_status` 컬럼 추가)
2. Queue 생성 (`npx wrangler queues create`)
3. `wrangler.toml` 설정 (producer, consumer, cron)
4. `src/index.js`에 `queue()`, `scheduled()` 핸들러 추가
5. `routes/sessions.js`의 `create-with-contents`에 분기 로직 추가
6. 배포 및 테스트
7. LMS 콜백 엔드포인트 개발 (LMS 측)
