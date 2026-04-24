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

// DB 미들웨어: HYPERDRIVE → PG 래퍼, 없으면 D1 fallback
app.use('*', async (c, next) => {
  c.env.DB = createDatabase(c.env);
  await next();
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
    // 세션 유효성 확인
    const session = await c.env.DB.prepare('SELECT status, generation_status FROM TB_SESSION WHERE id = ?')
      .bind(sessionId).first();
    if (!session || session.status === -1 || session.generation_status === 'completed') {
      console.log(`[Internal] Session ${sessionId} skipped`);
      return c.json({ success: true, sessionId, status: 'skipped' });
    }

    // 상태: processing
    await c.env.DB.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 1')
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
    try {
      await c.env.DB.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 1')
        .bind('failed', sessionId).run();
    } catch { /* ignore */ }

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
        { choiceCount: settings.choiceCount ?? 3, oxCount: settings.oxCount ?? 2, difficulty: settings.quizDifficulty || 'normal' },
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

  // Queue Consumer → D1 직접 사용 (네이티브 바인딩, I/O 제약 없음)
  // 처리 완료 후 PostgreSQL에 결과 동기화
  async queue(batch, env) {
    console.log(`[Queue] Batch received: ${batch.messages.length} messages`);

    // D1을 DB로 사용 (Queue에서는 D1이 안정적)
    const d1 = env.D1_DB;
    // PostgreSQL 동기화용
    const pg = env.HYPERDRIVE ? createDatabase(env) : null;

    for (const msg of batch.messages) {
      const { type, sessionId, siteId, contentIds, contents: contentDetails, settings, courseId, courseUserId, lessonId, userId, callbackUrl, callbackData } = msg.body;

      if (type === 'quiz-generation') {
        // 퀴즈 생성 (D1 사용)
        try {
          console.log(`[Queue/Quiz] Session ${sessionId} started`);
          const quizService = new QuizService({ ...env, DB: d1 }, siteId || 0);
          quizService.setContext(sessionId, lessonId);
          const choiceCount = settings.choiceCount ?? 3;
          const oxCount = settings.oxCount ?? 2;

          const contentTexts = [];
          for (const contentId of contentIds) {
            const content = await d1.prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1 AND site_id = ?')
              .bind(contentId, siteId || 0).first();
            if (content?.content?.trim().length >= 100) contentTexts.push(content.content);
          }
          const merged = contentTexts.join('\n\n---\n\n');
          if (merged.trim().length >= 100) {
            await quizService.generateQuizzesForContent(
              contentIds[0], merged,
              { choiceCount, oxCount, difficulty: settings.quizDifficulty || 'normal' },
              sessionId
            );
            // PG에 퀴즈 동기화
            if (pg) {
              const { results: quizzes } = await d1.prepare('SELECT * FROM TB_QUIZ WHERE session_id = ? AND status = 1').bind(sessionId).all();
              for (const q of (quizzes || [])) {
                await pg.prepare('INSERT INTO TB_QUIZ (id, content_id, session_id, quiz_type, question, options, answer, explanation, position, site_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
                  .bind(q.id, q.content_id, q.session_id, q.quiz_type, q.question, q.options, q.answer, q.explanation, q.position, q.site_id, q.status, q.created_at).run().catch(() => {});
              }
            }
          }
          console.log(`[Queue/Quiz] Session ${sessionId} completed`);
        } catch (err) {
          console.error(`[Queue/Quiz] Session ${sessionId} failed:`, err.message);
        }
        msg.ack();
        continue;
      }

      if (type !== 'session-generation') { msg.ack(); continue; }

      // 세션 유효성 확인
      const session = await d1.prepare('SELECT generation_status, status FROM TB_SESSION WHERE id = ?').bind(sessionId).first();
      if (!session || session.status === -1 || session.generation_status === 'completed') {
        msg.ack();
        continue;
      }

      try {
        // 상태: processing (D1)
        await d1.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('processing', sessionId).run();
        if (pg) pg.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('processing', sessionId).run().catch(() => {});

        console.log(`[Queue] Session ${sessionId} processing started`);

        // 학습 데이터 생성 (D1 사용)
        const learningService = new LearningService({ ...env, DB: d1 }, siteId || 0);
        learningService.setContext(sessionId, lessonId);
        const learningData = await learningService.generateAndStoreLearningData(sessionId, contentIds, settings);

        // 상태: completed (D1)
        await d1.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('completed', sessionId).run();

        console.log(`[Queue] Session ${sessionId} completed`);

        // PostgreSQL 동기화 (세션 결과 복사)
        if (pg) {
          try {
            const updated = await d1.prepare('SELECT * FROM TB_SESSION WHERE id = ?').bind(sessionId).first();
            if (updated) {
              await pg.prepare('UPDATE TB_SESSION SET session_nm = ?, generation_status = ?, learning_goal = ?, learning_summary = ?, recommended_questions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .bind(updated.session_nm, 'completed', updated.learning_goal, updated.learning_summary, updated.recommended_questions, sessionId).run();
            }
            console.log(`[Queue] Session ${sessionId} synced to PostgreSQL`);
          } catch (syncErr) {
            console.error(`[Queue] Session ${sessionId} PG sync failed:`, syncErr.message);
          }
        }

        // 퀴즈 생성 (Queue에 별도 메시지)
        const choiceCount = settings.choiceCount ?? 3;
        const oxCount = settings.oxCount ?? 2;
        if (choiceCount + oxCount > 0 && env.QUEUE) {
          await env.QUEUE.send({
            type: 'quiz-generation',
            sessionId, siteId, contentIds, settings, lessonId
          }).catch(() => {});
        }

        // LMS 콜백
        if (callbackUrl) {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId, siteId, generationStatus: 'completed',
              title: learningData.sessionNm || session.session_nm || '새 대화',
              courseId, courseUserId, lessonId, userId,
              contents: contentDetails || contentIds.map(id => ({ id })),
              learning: { goal: learningData.learningGoal, summary: learningData.learningSummary, recommendedQuestions: learningData.recommendedQuestions },
              callbackData
            })
          }).catch(() => {});
        }

      } catch (error) {
        console.error(`[Queue] Session ${sessionId} failed:`, error.message);
        await d1.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('failed', sessionId).run().catch(() => {});
        if (pg) pg.prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('failed', sessionId).run().catch(() => {});

        if (callbackUrl) {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, siteId, generationStatus: 'failed', error: error.message, callbackData })
          }).catch(() => {});
        }

        msg.retry();
        continue;
      }

      msg.ack();
    }

    // PG 커넥션 정리
    if (pg?.cleanup) await pg.cleanup();
  },

  // Cron Trigger → 비정상 상태 정리 (5분마다, D1 + PG 동시)
  async scheduled(event, env) {
    const d1 = env.D1_DB;
    const pg = env.HYPERDRIVE ? createDatabase(env) : null;

    // D1: 10분 넘게 processing → failed (SQLite 문법)
    const r1 = await d1.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'processing' AND updated_at < datetime('now', '-10 minutes')
    `).run();
    if (r1.meta.changes > 0) console.log(`[Cron/D1] ${r1.meta.changes}개 processing → failed`);

    // D1: 30분 넘게 pending → failed
    const r2 = await d1.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'pending' AND updated_at < datetime('now', '-30 minutes')
    `).run();
    if (r2.meta.changes > 0) console.log(`[Cron/D1] ${r2.meta.changes}개 pending → failed`);

    // PG도 동일 처리
    if (pg) {
      try {
        await pg.prepare(`UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE generation_status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'`).run();
        await pg.prepare(`UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE generation_status = 'pending' AND updated_at < NOW() - INTERVAL '30 minutes'`).run();
        await pg.cleanup();
      } catch (e) { console.error('[Cron/PG]', e.message); }
    }
  }
};
