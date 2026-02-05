/**
 * Sessions Routes
 *
 * 채팅 세션 관리 API 엔드포인트
 * GET /sessions - 세션 목록 조회
 * POST /sessions - 새 세션 생성
 * GET /sessions/:id - 세션 상세 조회 (메시지 포함)
 * GET /sessions/:id/quizzes - 세션 퀴즈 조회
 * POST /sessions/:id/quizzes - 퀴즈 생성
 * DELETE /sessions/:id - 세션 삭제
 */
import { Hono } from 'hono';
import { QuizService } from '../services/quizService.js';
import { LearningService } from '../services/learningService.js';

const sessions = new Hono();

/**
 * GET /sessions
 * 세션 목록 조회
 *
 * Query Parameters:
 * - page: 페이지 번호 (기본값: 1)
 * - limit: 페이지당 개수 (기본값: 50, 최대: 100)
 */
sessions.get('/', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;

    // 전체 개수 조회 (status = 1만)
    const countResult = await c.env.DB
      .prepare('SELECT COUNT(*) as total FROM TB_SESSION WHERE status = 1')
      .first();
    const total = countResult?.total || 0;

    // 세션 목록 조회 (status = 1만, 메시지도 status = 1만)
    const { results } = await c.env.DB
      .prepare(`
        SELECT
          s.id,
          s.session_nm,
          s.created_at,
          s.updated_at,
          (SELECT content FROM TB_MESSAGE WHERE session_id = s.id AND status = 1 ORDER BY created_at ASC LIMIT 1) as firstMessage,
          (SELECT content FROM TB_MESSAGE WHERE session_id = s.id AND status = 1 ORDER BY created_at DESC LIMIT 1) as lastMessage,
          (SELECT COUNT(*) FROM TB_MESSAGE WHERE session_id = s.id AND status = 1) as messageCount
        FROM TB_SESSION s
        WHERE s.status = 1
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(limit, offset)
      .all();

    // 제목: DB 저장된 제목 우선, 없으면 첫 메시지 기반 생성
    const sessionsWithTitle = (results || []).map(session => {
      let title = session.session_nm;
      if (!title) {
        title = session.firstMessage
          ? session.firstMessage.substring(0, 30) + (session.firstMessage.length > 30 ? '...' : '')
          : '새 대화';
      }
      return {
        id: session.id,
        title,
        lastMessage: session.lastMessage
          ? session.lastMessage.substring(0, 50) + (session.lastMessage.length > 50 ? '...' : '')
          : null,
        messageCount: session.messageCount || 0,
        created_at: session.created_at,
        updated_at: session.updated_at
      };
    });

    return c.json({
      success: true,
      data: {
        sessions: sessionsWithTitle,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    console.error('List sessions error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '세션 목록 조회 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * POST /sessions
 * 새 세션 생성
 *
 * Body:
 * - user_id: 사용자 ID (선택)
 * - course_id: 코스 ID (선택)
 * - course_user_id: 코스 사용자 ID (선택)
 * - lesson_id: 레슨 ID (선택)
 * - content_ids: 연결할 콘텐츠 ID 배열 (필수, 최소 1개)
 * - settings: AI 설정 (선택) { persona, temperature, topP }
 */
sessions.post('/', async (c) => {
  try {
    // 요청 본문 파싱
    let userId = null;
    let courseId = null;
    let courseUserId = null;
    let lessonId = null;
    let contentIds = [];
    let settings = {};

    try {
      const body = await c.req.json();
      userId = body.user_id || null;
      courseId = body.course_id || null;
      courseUserId = body.course_user_id || null;
      lessonId = body.lesson_id || null;
      contentIds = Array.isArray(body.content_ids) ? body.content_ids : [];
      settings = body.settings || {};
    } catch {
      // JSON 파싱 실패
    }

    // 학습 자료 필수 검증
    if (contentIds.length === 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '최소 하나 이상의 학습 자료를 선택해 주세요.'
        }
      }, 400);
    }

    // 세션 생성 (AI 설정 포함)
    const insertResult = await c.env.DB
      .prepare(`
        INSERT INTO TB_SESSION (course_id, course_user_id, lesson_id, user_id, persona, temperature, top_p, max_tokens, summary_count, recommend_count, quiz_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        courseId,
        courseUserId,
        lessonId,
        userId,
        settings.persona || null,
        settings.temperature ?? null,
        settings.topP ?? null,
        settings.maxTokens ?? null,
        settings.summaryCount ?? null,
        settings.recommendCount ?? null,
        settings.quizCount ?? null
      )
      .run();

    const sessionId = insertResult.meta.last_row_id;

    // 콘텐츠 연결 (TB_SESSION_CONTENT)
    if (contentIds.length > 0) {
      for (const contentId of contentIds) {
        await c.env.DB
          .prepare('INSERT INTO TB_SESSION_CONTENT (session_id, content_id) VALUES (?, ?)')
          .bind(sessionId, contentId)
          .run();
      }
    }

    // 학습 목표, 요약, 추천 질문 생성 및 Vectorize에 저장
    const learningService = new LearningService(c.env);
    const learningData = await learningService.generateAndStoreLearningData(sessionId, contentIds, settings);

    // 생성된 세션 조회 (학습 데이터 포함)
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ?')
      .bind(sessionId)
      .first();

    // 연결된 콘텐츠 조회
    const { results: linkedContents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content_nm
        FROM TB_SESSION_CONTENT sc
        JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
        WHERE sc.session_id = ? AND sc.status = 1
      `)
      .bind(sessionId)
      .all();

    return c.json({
      success: true,
      data: {
        id: sessionId,
        userId: session.user_id,
        title: learningData.sessionNm || '새 대화',
        settings: {
          persona: session.persona,
          temperature: session.temperature,
          topP: session.top_p,
          maxTokens: session.max_tokens,
          summaryCount: session.summary_count,
          recommendCount: session.recommend_count,
          quizCount: session.quiz_count
        },
        learning: {
          goal: learningData.learningGoal,
          summary: learningData.learningSummary,
          recommendedQuestions: learningData.recommendedQuestions
        },
        contents: linkedContents || [],
        lastMessage: null,
        messageCount: 0,
        created_at: session.created_at,
        updated_at: session.updated_at,
        _debug: learningData.error ? { learningError: learningData.error } : undefined
      },
      message: '새 세션이 생성되었습니다.'
    }, 201);

  } catch (error) {
    console.error('Create session error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '세션 생성 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * GET /sessions/:id
 * 세션 상세 조회 (메시지 포함)
 */
sessions.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 세션 ID가 필요합니다.'
        }
      }, 400);
    }

    // 세션 조회 (status = 1만)
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        }
      }, 404);
    }

    // 메시지 조회 (status = 1만)
    const { results: messages } = await c.env.DB
      .prepare(`
        SELECT id, role, content, created_at
        FROM TB_MESSAGE
        WHERE session_id = ? AND status = 1
        ORDER BY created_at ASC
      `)
      .bind(id)
      .all();

    // 연결된 콘텐츠 조회
    const { results: linkedContents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content_nm
        FROM TB_SESSION_CONTENT sc
        JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
        WHERE sc.session_id = ? AND sc.status = 1
      `)
      .bind(id)
      .all();

    // 제목: DB에 저장된 제목 사용, 없으면 첫 메시지 기반 생성
    let title = session.session_nm;
    if (!title) {
      const firstUserMessage = (messages || []).find(m => m.role === 'user');
      title = firstUserMessage
        ? firstUserMessage.content.substring(0, 30) + (firstUserMessage.content.length > 30 ? '...' : '')
        : '새 대화';
    }

    // 학습 요약 파싱 (배열 형태로 저장됨)
    let learningSummary = null;
    if (session.learning_summary) {
      try {
        learningSummary = JSON.parse(session.learning_summary);
      } catch {
        learningSummary = session.learning_summary; // 파싱 실패시 문자열 그대로
      }
    }

    // 추천 질문 파싱
    let recommendedQuestions = [];
    if (session.recommended_questions) {
      try {
        recommendedQuestions = JSON.parse(session.recommended_questions);
      } catch {
        recommendedQuestions = [];
      }
    }

    return c.json({
      success: true,
      data: {
        id: session.id,
        userId: session.user_id,
        title,
        settings: {
          persona: session.persona,
          temperature: session.temperature,
          topP: session.top_p,
          maxTokens: session.max_tokens,
          summaryCount: session.summary_count,
          recommendCount: session.recommend_count,
          quizCount: session.quiz_count
        },
        learning: {
          goal: session.learning_goal || null,
          summary: learningSummary,
          recommendedQuestions: recommendedQuestions
        },
        contents: linkedContents || [],
        messages: messages || [],
        messageCount: (messages || []).length,
        created_at: session.created_at,
        updated_at: session.updated_at
      }
    });

  } catch (error) {
    console.error('Get session error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '세션 조회 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * PUT /sessions/:id
 * 세션 AI 설정 업데이트
 */
sessions.put('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 세션 ID가 필요합니다.'
        }
      }, 400);
    }

    // 세션 존재 확인 (status = 1만)
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        }
      }, 404);
    }

    // 요청 본문에서 설정 추출
    const body = await c.req.json();
    const { settings } = body;

    if (!settings) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'settings 필드는 필수입니다.'
        }
      }, 400);
    }

    // 설정 값 검증 및 기본값 적용
    const persona = settings.persona ?? session.persona;
    const temperature = settings.temperature !== undefined
      ? Math.max(0, Math.min(1, settings.temperature))
      : session.temperature;
    const topP = settings.topP !== undefined
      ? Math.max(0.1, Math.min(1, settings.topP))
      : session.top_p;
    const maxTokens = settings.maxTokens !== undefined
      ? Math.max(256, Math.min(4096, settings.maxTokens))
      : session.max_tokens;

    // 학습 설정 값 검증 및 기본값 적용
    const summaryCount = settings.summaryCount !== undefined
      ? Math.max(1, Math.min(10, settings.summaryCount))
      : session.summary_count;
    const recommendCount = settings.recommendCount !== undefined
      ? Math.max(1, Math.min(10, settings.recommendCount))
      : session.recommend_count;
    const quizCount = settings.quizCount !== undefined
      ? Math.max(1, Math.min(20, settings.quizCount))
      : session.quiz_count;

    // 세션 업데이트
    await c.env.DB
      .prepare(`
        UPDATE TB_SESSION
        SET persona = ?, temperature = ?, top_p = ?, max_tokens = ?,
            summary_count = ?, recommend_count = ?, quiz_count = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(persona, temperature, topP, maxTokens, summaryCount, recommendCount, quizCount, id)
      .run();

    return c.json({
      success: true,
      data: {
        id,
        settings: {
          persona,
          temperature,
          topP,
          maxTokens,
          summaryCount,
          recommendCount,
          quizCount
        }
      },
      message: 'AI 설정이 업데이트되었습니다.'
    });

  } catch (error) {
    console.error('Update session error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '세션 업데이트 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * GET /sessions/:id/quizzes
 * 세션에 연결된 콘텐츠의 퀴즈 조회
 */
sessions.get('/:id/quizzes', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 세션 ID가 필요합니다.'
        }
      }, 400);
    }

    // 세션 존재 확인 (status = 1만)
    const session = await c.env.DB
      .prepare('SELECT id, quiz_count FROM TB_SESSION WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        }
      }, 404);
    }

    // 세션에 연결된 콘텐츠 ID 조회
    const { results: contents } = await c.env.DB
      .prepare(`
        SELECT content_id
        FROM TB_SESSION_CONTENT
        WHERE session_id = ? AND status = 1
      `)
      .bind(id)
      .all();

    const contentIds = (contents || []).map(c => c.content_id);

    if (contentIds.length === 0) {
      return c.json({
        success: true,
        data: {
          sessionId: id,
          quizzes: [],
          total: 0
        }
      });
    }

    // 콘텐츠의 퀴즈 조회 (설정된 퀴즈 수 만큼 제한)
    const quizService = new QuizService(c.env);
    const quizzes = await quizService.getQuizzesByContentIds(contentIds, session.quiz_count);

    return c.json({
      success: true,
      data: {
        sessionId: id,
        quizzes,
        total: quizzes.length
      }
    });

  } catch (error) {
    console.error('Get quizzes error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '퀴즈 조회 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * POST /sessions/:id/quizzes
 * 세션에 연결된 콘텐츠의 퀴즈 재생성
 *
 * Body (optional):
 * - count: 콘텐츠당 생성할 퀴즈 수 (기본값: 세션 설정값)
 */
sessions.post('/:id/quizzes', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 세션 ID가 필요합니다.'
        }
      }, 400);
    }

    // 세션 조회 (status = 1만)
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        }
      }, 404);
    }

    // 연결된 콘텐츠 조회 (content 포함)
    const { results: contents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content
        FROM TB_CONTENT c
        JOIN TB_SESSION_CONTENT sc ON c.id = sc.content_id
        WHERE sc.session_id = ? AND sc.status = 1 AND c.status = 1
      `)
      .bind(id)
      .all();

    if (!contents || contents.length === 0) {
      return c.json({
        success: false,
        error: {
          code: 'NO_CONTENT',
          message: '연결된 학습 콘텐츠가 없습니다.'
        }
      }, 400);
    }

    // 요청 본문에서 퀴즈 옵션 추출
    let quizOptions = { choiceCount: 3, oxCount: 2 };
    try {
      const body = await c.req.json();
      // 새로운 형식: choiceCount, oxCount
      if (body.choiceCount !== undefined || body.oxCount !== undefined) {
        quizOptions = {
          choiceCount: Math.max(0, Math.min(10, body.choiceCount ?? 3)),
          oxCount: Math.max(0, Math.min(10, body.oxCount ?? 2))
        };
      }
      // 하위 호환: count만 전달된 경우
      else if (body.count) {
        const totalCount = Math.max(1, Math.min(20, body.count));
        quizOptions = {
          choiceCount: Math.ceil(totalCount / 2),
          oxCount: totalCount - Math.ceil(totalCount / 2)
        };
      }
    } catch {
      // 기본값 사용
    }

    const quizService = new QuizService(c.env);
    const allQuizzes = [];

    // 각 콘텐츠별로 퀴즈 재생성
    for (const content of contents) {
      // 기존 퀴즈 삭제
      await quizService.deleteQuizzesByContent(content.id);

      // 새 퀴즈 생성
      if (content.content && content.content.trim().length > 0) {
        const quizzes = await quizService.generateQuizzesForContent(
          content.id,
          content.content,
          quizOptions
        );
        allQuizzes.push(...quizzes);
      }
    }

    return c.json({
      success: true,
      data: {
        sessionId: id,
        quizzes: allQuizzes,
        total: allQuizzes.length
      },
      message: `${allQuizzes.length}개의 퀴즈가 재생성되었습니다.`
    }, 201);

  } catch (error) {
    console.error('Regenerate quizzes error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '퀴즈 재생성 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * DELETE /sessions/:id
 * 세션 삭제 (Soft Delete)
 */
sessions.delete('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 세션 ID가 필요합니다.'
        }
      }, 400);
    }

    // 세션 존재 확인 (status = 1만)
    const session = await c.env.DB
      .prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '세션을 찾을 수 없습니다.'
        }
      }, 404);
    }

    // 메시지 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_MESSAGE SET status = -1 WHERE session_id = ?')
      .bind(id)
      .run();

    // 세션-콘텐츠 연결 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_SESSION_CONTENT SET status = -1 WHERE session_id = ?')
      .bind(id)
      .run();

    // 퀴즈는 콘텐츠 기반이므로 세션 삭제 시 영향 없음
    // (TB_QUIZ는 content_id를 사용)

    // Vectorize에서 학습 임베딩 삭제
    const learningService = new LearningService(c.env);
    await learningService.deleteLearningEmbeddings(id);

    // 세션 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_SESSION SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(id)
      .run();

    return c.json({
      success: true,
      message: '세션이 성공적으로 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete session error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '세션 삭제 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

export default sessions;
