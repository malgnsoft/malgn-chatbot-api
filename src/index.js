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

// ============================================
// Queue Consumer + Cron Trigger
// ============================================
import { LearningService } from './services/learningService.js';
import { QuizService } from './services/quizService.js';

export default {
  // HTTP 요청 → Hono
  fetch: app.fetch,

  // Queue Consumer → 세션 학습데이터/퀴즈 백그라운드 생성
  async queue(batch, env) {
    for (const msg of batch.messages) {
      // 매 메시지마다 새 커넥션 생성 (AI 호출 중 idle timeout 방지)
      env.DB = createDatabase(env);

      const { type, sessionId, siteId, contentIds, contents: contentDetails, settings, courseId, courseUserId, lessonId, userId, callbackUrl, callbackData } = msg.body;

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
        // 상태: processing
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('processing', sessionId)
          .run();

        console.log(`[Queue] Session ${sessionId} processing started`);

        // 학습 데이터 생성
        const learningService = new LearningService(env, siteId || 0);
        const learningData = await learningService.generateAndStoreLearningData(sessionId, contentIds, settings);

        // 퀴즈 생성
        const quizService = new QuizService(env, siteId || 0);
        const choiceCount = settings.choiceCount ?? 3;
        const oxCount = settings.oxCount ?? 2;

        if (choiceCount + oxCount > 0) {
          const contentTexts = [];
          for (const contentId of contentIds) {
            const content = await env.DB
              .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1 AND site_id = ?')
              .bind(contentId, siteId || 0)
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

        // 상태: completed
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('completed', sessionId)
          .run();

        console.log(`[Queue] Session ${sessionId} completed`);

        // LMS 콜백 (성공) - 동기 응답(201)과 동일 수준의 데이터 전송
        if (callbackUrl) {
          // 세션 조회 (설정값 포함)
          const sessionData = await env.DB
            .prepare('SELECT * FROM TB_SESSION WHERE id = ?')
            .bind(sessionId)
            .first();

          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              siteId,
              generationStatus: 'completed',
              title: learningData.sessionNm || sessionData?.session_nm || '새 대화',
              courseId: sessionData?.course_id || null,
              courseUserId: sessionData?.course_user_id || null,
              lessonId: sessionData?.lesson_id || null,
              userId: sessionData?.user_id || null,
              contents: contentDetails || contentIds.map(id => ({ id })),
              settings: {
                persona: sessionData?.persona,
                temperature: sessionData?.temperature,
                topP: sessionData?.top_p,
                maxTokens: sessionData?.max_tokens,
                summaryCount: sessionData?.summary_count,
                recommendCount: sessionData?.recommend_count,
                choiceCount: sessionData?.choice_count,
                oxCount: sessionData?.ox_count,
                quizDifficulty: sessionData?.quiz_difficulty || 'normal'
              },
              learning: {
                goal: learningData.learningGoal,
                summary: learningData.learningSummary,
                recommendedQuestions: learningData.recommendedQuestions
              },
              quiz: { choiceCount, oxCount },
              callbackData
            })
          });
        }

      } catch (error) {
        console.error(`[Queue] Session ${sessionId} failed:`, error.message);

        // 상태: failed
        await env.DB
          .prepare('UPDATE TB_SESSION SET generation_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind('failed', sessionId)
          .run();

        // LMS 콜백 (실패)
        if (callbackUrl) {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              siteId,
              generationStatus: 'failed',
              error: error.message,
              lessonId: lessonId || null,
              contents: contentDetails || contentIds.map(id => ({ id })),
              callbackData
            })
          }).catch(() => {});
        }

        msg.retry();
        if (env.DB?.cleanup) await env.DB.cleanup();
        return;
      }

      msg.ack();
      if (env.DB?.cleanup) await env.DB.cleanup();
    }
  },

  // Cron Trigger → 비정상 상태 정리 (5분마다)
  async scheduled(event, env) {
    env.DB = createDatabase(env);

    // 10분 넘게 processing → failed (MySQL 호환 문법)
    const r1 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'processing' AND updated_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    `).run();
    if (r1.meta.changes > 0) console.log(`[Cron] ${r1.meta.changes}개 processing → failed`);

    // 30분 넘게 pending → failed
    const r2 = await env.DB.prepare(`
      UPDATE TB_SESSION SET generation_status = 'failed', updated_at = CURRENT_TIMESTAMP
      WHERE generation_status = 'pending' AND updated_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
    `).run();
    if (r2.meta.changes > 0) console.log(`[Cron] ${r2.meta.changes}개 pending → failed`);

    // MySQL 커넥션 정리
    if (env.DB?.cleanup) await env.DB.cleanup();
  }
};
