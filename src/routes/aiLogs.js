/**
 * AI Logs Routes
 *
 * AI 사용 로그 조회 API
 * GET /ai-logs - 로그 목록 조회
 * GET /ai-logs/summary - 사용량 요약
 */
import { Hono } from 'hono';
import { AiLogService } from '../services/aiLogService.js';

const aiLogs = new Hono();

/**
 * GET /ai-logs
 * AI 사용 로그 목록 조회
 *
 * Query Parameters:
 * - page: 페이지 번호 (기본값: 1)
 * - limit: 페이지당 개수 (기본값: 50, 최대: 100)
 * - type: 요청 유형 필터 (chat, learning, quiz_choice, quiz_ox, embedding)
 * - startDate: 시작일 (YYYY-MM-DD)
 * - endDate: 종료일 (YYYY-MM-DD)
 */
aiLogs.get('/', async (c) => {
  try {
    const siteId = c.get('siteId');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const requestType = c.req.query('type') || null;
    const startDate = c.req.query('startDate') || null;
    const endDate = c.req.query('endDate') || null;

    const aiLogService = new AiLogService(c.env, siteId);
    const result = await aiLogService.getLogs({ page, limit, requestType, startDate, endDate });

    return c.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get AI logs error:', error);
    return c.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'AI 로그 조회 중 오류가 발생했습니다.' }
    }, 500);
  }
});

/**
 * GET /ai-logs/summary
 * AI 사용량 요약 (request_type별 집계)
 *
 * Query Parameters:
 * - startDate: 시작일 (YYYY-MM-DD)
 * - endDate: 종료일 (YYYY-MM-DD)
 */
aiLogs.get('/summary', async (c) => {
  try {
    const siteId = c.get('siteId');
    const startDate = c.req.query('startDate') || null;
    const endDate = c.req.query('endDate') || null;

    const aiLogService = new AiLogService(c.env, siteId);
    const result = await aiLogService.getSummary({ startDate, endDate });

    return c.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get AI logs summary error:', error);
    return c.json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'AI 사용량 요약 조회 중 오류가 발생했습니다.' }
    }, 500);
  }
});

export default aiLogs;
