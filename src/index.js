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

// Import OpenAPI spec
import openApiSpec from './openapi.js';

const app = new Hono();

// Global middleware
app.use('*', logger());

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

export default app;
