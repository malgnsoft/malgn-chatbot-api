/**
 * Chat Routes
 *
 * 채팅 관련 API 엔드포인트
 * POST /chat - 채팅 메시지 전송 및 응답
 * POST /chat/stream - SSE 스트리밍 채팅 응답
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
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

/**
 * POST /chat/stream
 * SSE 스트리밍 방식으로 AI 응답 생성
 */
chat.post('/stream', async (c) => {
  const body = await c.req.json();
  const { message, sessionId, settings } = body;

  // 입력 검증
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'message 필드는 필수이며 문자열이어야 합니다.' }
    }, 400);
  }
  if (message.length > 10000) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: '메시지가 너무 깁니다. (최대 10000자)' }
    }, 400);
  }

  const chatService = new ChatService(c.env);

  // RAG 컨텍스트 준비 (임베딩, 벡터 검색, 대화 내역)
  let prepared;
  try {
    prepared = await chatService.prepareChatContext(message.trim(), sessionId, settings || {});
  } catch (error) {
    console.error('Chat stream prepare error:', error.message);
    return c.json({
      success: false,
      error: { code: 'AI_ERROR', message: 'AI 처리 중 오류가 발생했습니다.' }
    }, 500);
  }

  // 검색 결과 없음 → 즉시 응답
  if (prepared.noContext) {
    return streamSSE(c, async (stream) => {
      const noContextMsg = '죄송합니다. 해당 질문에 대한 학습된 정보가 없습니다. 다른 질문을 해주시거나, 관련 문서를 업로드해 주세요.';
      await stream.writeSSE({ event: 'token', data: JSON.stringify({ response: noContextMsg }) });
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ sources: prepared.sources, sessionId: prepared.sessionId }) });

      // DB 저장
      if (prepared.sessionId) {
        c.executionCtx.waitUntil(chatService.saveMessagesToDB(prepared.sessionId, message.trim(), noContextMsg));
      }
    });
  }

  // LLM 스트리밍 응답 생성
  return streamSSE(c, async (stream) => {
    try {
      const aiStream = await chatService.generateResponseStream(prepared.messages);

      // Workers AI SSE 스트림 파싱 및 재전송
      const reader = aiStream.pipeThrough(new TextDecoderStream()).getReader();
      let fullResponse = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.response) {
              fullResponse += parsed.response;
              await stream.writeSSE({ event: 'token', data: JSON.stringify({ response: parsed.response }) });
            }
          } catch { /* skip invalid JSON */ }
        }
      }

      // 완료 이벤트 전송
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ sources: prepared.sources, sessionId: prepared.sessionId }) });

      // DB 저장 (백그라운드)
      if (prepared.sessionId && fullResponse) {
        c.executionCtx.waitUntil(chatService.saveMessagesToDB(prepared.sessionId, message.trim(), fullResponse));
      }
    } catch (error) {
      console.error('Chat stream error:', error.message);
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'AI 응답 생성 중 오류가 발생했습니다.' }) });
    }
  });
});

export default chat;
