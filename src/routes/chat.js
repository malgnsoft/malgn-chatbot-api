/**
 * Chat Routes
 *
 * 채팅 관련 API 엔드포인트
 * POST /chat - 채팅 메시지 전송 및 응답
 */
import { Hono } from 'hono';
import { ChatService } from '../services/chatService.js';

const chat = new Hono();

/**
 * POST /chat
 * 사용자 메시지를 받아 AI 응답 생성
 *
 * Request Body:
 * {
 *   "message": "환불 정책이 어떻게 되나요?",
 *   "sessionId": "optional-session-id",
 *   "settings": {
 *     "persona": "AI 튜터 페르소나",
 *     "temperature": 0.7,
 *     "topP": 0.9,
 *     "maxTokens": 1024
 *   }
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "response": "환불은 구매 후 7일 이내에...",
 *     "sources": [...],
 *     "sessionId": "sess-abc123"
 *   }
 * }
 */
chat.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { message, sessionId, settings } = body;

    // 입력 검증
    if (!message || typeof message !== 'string') {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'message 필드는 필수이며 문자열이어야 합니다.'
        }
      }, 400);
    }

    if (message.trim().length === 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '메시지가 비어있습니다.'
        }
      }, 400);
    }

    // 메시지 길이 제한 (10000자)
    if (message.length > 10000) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '메시지가 너무 깁니다. (최대 10000자)'
        }
      }, 400);
    }

    // 채팅 서비스 호출
    const chatService = new ChatService(c.env);
    const result = await chatService.chat(message.trim(), sessionId, settings || {});

    return c.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Chat error:', error.message, error.stack);

    // AI 관련 에러
    if (error.message.includes('AI') || error.message.includes('임베딩')) {
      return c.json({
        success: false,
        error: {
          code: 'AI_ERROR',
          message: 'AI 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
          detail: error.message
        }
      }, 500);
    }

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '서버 오류가 발생했습니다.'
      }
    }, 500);
  }
});

export default chat;
