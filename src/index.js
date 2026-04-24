/**
 * AI Chatbot API - Entry Point
 *
 * Cloudflare Workers + Hono 기반 API 서버
 * RAG(Retrieval-Augmented Generation) 기반 채팅 기능 제공
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { swaggerUI } from '@hono/swagger-ui';

// Import routes
import chatRoutes from './routes/chat.js';
import contentsRoutes from './routes/contents.js';
import sessionsRoutes from './routes/sessions.js';
import aiLogsRoutes from './routes/aiLogs.js';
// Import middleware
import { errorHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';
// Import database
import { createDatabase } from './utils/database.js';

// Import OpenAPI spec
import openApiSpec from './openapi.js';

const app = new Hono();

// Global middleware
app.use('*', logger());

// DB 미들웨어: HYPERDRIVE → MySQL 래퍼, 없으면 D1 fallback
app.use('*', async (c, next) => {
  c.env.DB = createDatabase(c.env);
  await next();
  // MySQL 커넥션 정리
  if (c.env.DB?.cleanup) {
    c.executionCtx.waitUntil(c.env.DB.cleanup());
  }
});

// CORS 설정 - 모든 출처 허용 (개발용)
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Site-Id']
}));

// 보호 경로에 API Key 인증 미들웨어 적용
app.use('/chat/*', authMiddleware);
app.use('/contents/*', authMiddleware);
app.use('/sessions/*', authMiddleware);
app.use('/ai-logs/*', authMiddleware);

// Routes
app.route('/chat', chatRoutes);
app.route('/contents', contentsRoutes);
app.route('/sessions', sessionsRoutes);
app.route('/ai-logs', aiLogsRoutes);

// Root endpoint → docs 리다이렉트
app.get('/', (c) => c.redirect('/docs'));

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// API Documentation
app.get('/openapi.json', (c) => c.json(openApiSpec));
app.get('/docs', swaggerUI({ url: '/openapi.json' }));

// ============================================
// 내부 API: Queue → self-fetch로 세션 처리
// (별도 HTTP 컨텍스트에서 실행 → I/O 충돌 없음)
// ============================================
import { LearningService } from './services/learningService.js';
import { QuizService } from './services/quizService.js';

app.post('/internal/process-session', async (c) => {
  // 내부 키 검증
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey !== c.env.API_KEY) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const { sessionId, siteId, contentIds, contents: contentDetails, settings, callbackUrl, callbackData, lessonId } = await c.req.json();
  console.log(`[Internal] Session ${sessionId} processing started`);

  try {
    // 세션 유효성 확인 (삭제/완료된 세션은 스킵)
    const session = await c.env.DB.prepare('SELECT status, generation_status FROM TB_SESSION WHERE id = ?')
      .bind(sessionId).first();
    if (!session || session.status === -1 || session.generation_status === 'completed') {
      console.log(`[Internal] Session ${sessionId} skipped (status=${session?.status}, gen=${session?.generation_status})`);
      return c.json({ success: true, sessionId, status: 'skipped' });
    }

    // 상태: processing
    await c.env.DB.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 1 AND status = 1')
      .bind('processing', sessionId).run();

    // ── 1단계: 학습 데이터 생성 (~8초) ──
    const learningService = new LearningService(c.env, siteId || 0);
    learningService.setContext(sessionId, lessonId);
    const learningData = await learningService.generateAndStoreLearningData(sessionId, contentIds, settings);

    // 즉시 completed (학습 데이터 생성 완료 = 세션 사용 가능)
    await c.env.DB.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 1')
      .bind('completed', sessionId).run();

    console.log(`[Internal] Session ${sessionId} completed (learning done)`);

    // LMS 콜백 (성공)
    if (callbackUrl) {
      const sessionData = await c.env.DB.prepare('SELECT * FROM TB_SESSION WHERE id = ?').bind(sessionId).first();
      c.executionCtx.waitUntil(fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, siteId, generationStatus: 'completed',
          title: learningData.sessionNm || sessionData?.session_nm || '새 대화',
          courseId: sessionData?.course_id, courseUserId: sessionData?.course_user_id,
          lessonId: sessionData?.lesson_id, userId: sessionData?.user_id,
          contents: contentDetails || contentIds.map(id => ({ id })),
          learning: { goal: learningData.learningGoal, summary: learningData.learningSummary, recommendedQuestions: learningData.recommendedQuestions },
          callbackData
        })
      }).catch(() => {}));
    }

    // ── 2단계: 퀴즈 생성 (Queue에 별도 메시지로 전송) ──
    const choiceCount = settings.choiceCount ?? 3;
    const oxCount = settings.oxCount ?? 2;

    if (choiceCount + oxCount > 0 && c.env.QUEUE) {
      c.executionCtx.waitUntil(c.env.QUEUE.send({
        type: 'quiz-generation',
        sessionId, siteId, contentIds, settings, lessonId
      }).catch(err => console.error(`[Internal] Quiz queue error for session ${sessionId}:`, err.message)));
    }

    return c.json({ success: true, sessionId, status: 'completed' });

  } catch (error) {
    console.error(`[Internal] Session ${sessionId} failed:`, error.message);

    // 상태: failed
    try {
      await c.env.DB.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 1')
        .bind('failed', sessionId).run();
    } catch { /* ignore */ }

    // LMS 콜백 (실패)
    if (callbackUrl) {
      c.executionCtx.waitUntil(fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, siteId, generationStatus: 'failed', error: error.message, callbackData })
      }).catch(() => {}));
    }

    return c.json({ success: false, error: error.message }, 500);
  }
});

// 내부 API: 퀴즈 생성 (2단계, 백그라운드)
app.post('/internal/generate-quiz', async (c) => {
  const internalKey = c.req.header('X-Internal-Key');
  if (internalKey !== c.env.API_KEY) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const { sessionId, siteId, contentIds, settings, lessonId } = await c.req.json();
  console.log(`[Internal/Quiz] Session ${sessionId} quiz generation started`);

  try {
    const quizService = new QuizService(c.env, siteId || 0);
    quizService.setContext(sessionId, lessonId);
    const choiceCount = settings.choiceCount ?? 3;
    const oxCount = settings.oxCount ?? 2;

    const contentTexts = [];
    for (const contentId of contentIds) {
      const content = await c.env.DB
        .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1 AND site_id = ?')
        .bind(contentId, siteId || 0).first();
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

    console.log(`[Internal/Quiz] Session ${sessionId} quiz generation completed`);
    return c.json({ success: true, sessionId });

  } catch (error) {
    console.error(`[Internal/Quiz] Session ${sessionId} quiz failed:`, error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Error handling
app.onError(errorHandler);

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: '요청한 경로를 찾을 수 없습니다.',
      path: c.req.path
    }
  }, 404);
});

export default {
  // HTTP 요청 → Hono
  fetch: app.fetch,

  // Queue Consumer → self-fetch 디스패처
  // 직접 AI/DB 작업을 하지 않고, 자신의 /internal/process-session 엔드포인트를 호출합니다.
  // 각 메시지가 별도 HTTP 요청 컨텍스트에서 실행되므로 I/O 충돌이 발생하지 않습니다.
  async queue(batch, env) {
    console.log(`[Queue] Batch received: ${batch.messages.length} messages`);

    // Worker의 자기 자신 URL 결정
    const workerUrl = env.ENVIRONMENT === 'production'
      ? `https://malgn-chatbot-api-${env.TENANT_ID}.malgnsoft.workers.dev`
      : 'https://malgn-chatbot-api.malgnsoft.workers.dev';

    for (const msg of batch.messages) {
      const { type, sessionId } = msg.body;

      // 엔드포인트 결정
      let endpoint;
      if (type === 'session-generation') endpoint = '/internal/process-session';
      else if (type === 'quiz-generation') endpoint = '/internal/generate-quiz';

      if (!endpoint) { msg.ack(); continue; }

      console.log(`[Queue] Dispatching ${type} session=${sessionId} → ${endpoint}`);

      // fetch 전송 후 응답 대기 — 내부 API가 완료될 때까지 기다림
      // Queue consumer는 15분 wall clock 제한이므로 충분
      try {
        const res = await fetch(`${workerUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.API_KEY, 'X-Site-Id': String(msg.body.siteId || 0) },
          body: JSON.stringify(msg.body)
        });
        console.log(`[Queue] ${type} session=${sessionId} → ${res.status}`);
      } catch (err) {
        console.error(`[Queue] ${type} session=${sessionId} → error: ${err.message}`);
      }
      msg.ack();
    }
  },

  // Cron Trigger → 비정상 상태 정리 (5분마다)
  async scheduled(event, env) {
    env.DB = createDatabase(env);

    // 10분 넘게 processing → failed
    const r1 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'
    `).run();
    if (r1.meta.changes > 0) console.log(`[Cron] ${r1.meta.changes}개 processing → failed`);

    // 30분 넘게 pending → failed
    const r2 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'pending' AND updated_at < NOW() - INTERVAL '30 minutes'
    `).run();
    if (r2.meta.changes > 0) console.log(`[Cron] ${r2.meta.changes}개 pending → failed`);

    // MySQL 커넥션 정리
    if (env.DB?.cleanup) await env.DB.cleanup();
  }
};
