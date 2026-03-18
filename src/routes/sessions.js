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

    // 전체 개수 조회 (부모 세션만, status = 1)
    const countResult = await c.env.DB
      .prepare('SELECT COUNT(*) as total FROM TB_SESSION WHERE status = 1 AND parent_id = 0')
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
        WHERE s.status = 1 AND s.parent_id = 0
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
 * - settings: AI 설정 (선택) { persona, temperature, topP, choiceCount, oxCount }
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
    let parentId = 0;

    try {
      const body = await c.req.json();
      console.log('[Session POST] body:', JSON.stringify(body));
      userId = body.user_id != null ? parseInt(body.user_id, 10) : null;
      courseId = body.course_id || null;
      courseUserId = body.course_user_id || null;
      lessonId = body.lesson_id || null;
      contentIds = Array.isArray(body.content_ids) ? body.content_ids : [];
      settings = typeof body.settings === 'string' ? JSON.parse(body.settings) : (body.settings || {});
      parentId = body.parent_id || 0;
      console.log('[Session POST] parsed settings:', JSON.stringify(settings));
    } catch (e) {
      console.error('[Session POST] body parse error:', e.message);
    }

    // ── 자식 세션 생성 (parent_id > 0) ──
    if (parentId > 0) {
      // 부모 세션 존재 확인
      const parentSession = await c.env.DB
        .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND parent_id = 0')
        .bind(parentId)
        .first();

      if (!parentSession) {
        return c.json({
          success: false,
          error: { code: 'NOT_FOUND', message: '부모 세션을 찾을 수 없습니다.' }
        }, 404);
      }

      // 동일 부모 + 수강생 + 레슨 자식 존재 확인
      if (courseUserId) {
        let existingChildQuery = 'SELECT id FROM TB_SESSION WHERE parent_id = ? AND course_user_id = ? AND status = 1';
        const bindParams = [parentId, courseUserId];
        if (lessonId) {
          existingChildQuery += ' AND lesson_id = ?';
          bindParams.push(lessonId);
        } else {
          existingChildQuery += ' AND (lesson_id IS NULL OR lesson_id = 0)';
        }
        const existingChild = await c.env.DB
          .prepare(existingChildQuery)
          .bind(...bindParams)
          .first();

        if (existingChild) {
          // 기존 자식 세션 반환
          const childSession = await c.env.DB
            .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
            .bind(existingChild.id)
            .first();

          const { results: messages } = await c.env.DB
            .prepare('SELECT id, role, content, created_at FROM TB_MESSAGE WHERE session_id = ? AND status = 1 ORDER BY created_at ASC')
            .bind(existingChild.id)
            .all();

          const { results: linkedContents } = await c.env.DB
            .prepare(`
              SELECT c.id, c.content_nm
              FROM TB_SESSION_CONTENT sc
              JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
              WHERE sc.session_id = ? AND sc.status = 1
            `)
            .bind(parentId)
            .all();

          let learningSummary = null;
          if (parentSession.learning_summary) {
            try { learningSummary = JSON.parse(parentSession.learning_summary); } catch {}
          }
          let recommendedQuestions = [];
          if (parentSession.recommended_questions) {
            try { recommendedQuestions = JSON.parse(parentSession.recommended_questions); } catch {}
          }

          return c.json({
            success: true,
            data: {
              session: { id: existingChild.id, parentId },
              id: existingChild.id,
              parentId,
              userId: childSession.user_id,
              title: parentSession.session_nm || '새 대화',
              settings: {
                persona: childSession.persona,
                temperature: childSession.temperature,
                topP: childSession.top_p,
                maxTokens: childSession.max_tokens,
                summaryCount: childSession.summary_count,
                recommendCount: childSession.recommend_count,
                choiceCount: childSession.choice_count,
                oxCount: childSession.ox_count
              },
              learning: {
                goal: parentSession.learning_goal || null,
                summary: learningSummary,
                recommendedQuestions
              },
              contents: linkedContents || [],
              messages: messages || [],
              messageCount: (messages || []).length,
              created_at: childSession.created_at,
              updated_at: childSession.updated_at
            }
          }, 200);
        }
      }

      // 새 자식 세션 생성 (부모 설정 복사, AI 생성 없음)
      const insertResult = await c.env.DB
        .prepare(`
          INSERT INTO TB_SESSION (parent_id, course_id, course_user_id, lesson_id, user_id,
            persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          parentId, courseId, courseUserId, lessonId, userId,
          parentSession.persona,
          parentSession.temperature,
          parentSession.top_p,
          parentSession.max_tokens,
          parentSession.summary_count,
          parentSession.recommend_count,
          parentSession.choice_count,
          parentSession.ox_count
        )
        .run();

      const childSessionId = insertResult.meta.last_row_id;

      // 부모의 콘텐츠 목록 조회
      const { results: linkedContents } = await c.env.DB
        .prepare(`
          SELECT c.id, c.content_nm
          FROM TB_SESSION_CONTENT sc
          JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
          WHERE sc.session_id = ? AND sc.status = 1
        `)
        .bind(parentId)
        .all();

      // 부모 학습 데이터 파싱
      let learningSummary = null;
      if (parentSession.learning_summary) {
        try { learningSummary = JSON.parse(parentSession.learning_summary); } catch {}
      }
      let recommendedQuestions = [];
      if (parentSession.recommended_questions) {
        try { recommendedQuestions = JSON.parse(parentSession.recommended_questions); } catch {}
      }

      return c.json({
        success: true,
        data: {
          session: { id: childSessionId, parentId },
          id: childSessionId,
          parentId,
          userId,
          title: parentSession.session_nm || '새 대화',
          settings: {
            persona: parentSession.persona,
            temperature: parentSession.temperature,
            topP: parentSession.top_p,
            maxTokens: parentSession.max_tokens,
            summaryCount: parentSession.summary_count,
            recommendCount: parentSession.recommend_count,
            choiceCount: parentSession.choice_count,
            oxCount: parentSession.ox_count
          },
          learning: {
            goal: parentSession.learning_goal || null,
            summary: learningSummary,
            recommendedQuestions
          },
          contents: linkedContents || [],
          messages: [],
          messageCount: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        message: '자식 세션이 생성되었습니다.'
      }, 201);
    }

    // ── 부모 세션 생성 (기존 로직) ──

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

    // 세션 생성 (AI 설정 포함, 미전달 시 DB DEFAULT 사용)
    const defaultPersona = '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변해 주세요.';
    const insertResult = await c.env.DB
      .prepare(`
        INSERT INTO TB_SESSION (parent_id, course_id, course_user_id, lesson_id, user_id, persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count, quiz_difficulty)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        0,
        courseId,
        courseUserId,
        lessonId,
        userId,
        settings.persona || defaultPersona,
        settings.temperature ?? 0.3,
        settings.topP ?? 0.3,
        settings.maxTokens ?? 1024,
        settings.summaryCount ?? 3,
        settings.recommendCount ?? 3,
        settings.choiceCount ?? 3,
        settings.oxCount ?? 2,
        settings.quizDifficulty || 'normal'
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

    // 퀴즈 생성 준비 (퀴즈 수가 0이면 스킵)
    const quizService = new QuizService(c.env);
    const totalQuizCount = (settings.choiceCount ?? 3) + (settings.oxCount ?? 2);
    const quizOptions = {
      choiceCount: settings.choiceCount ?? 3,
      oxCount: settings.oxCount ?? 2,
      difficulty: settings.quizDifficulty || 'normal'
    };

    let quizPromises = [];
    if (totalQuizCount > 0) {
      for (const contentId of contentIds) {
        const existingQuizzes = await quizService.getQuizzesByContent(contentId);
        const existingChoiceCount = existingQuizzes.filter(q => q.quiz_type === 'choice').length;
        const existingOxCount = existingQuizzes.filter(q => q.quiz_type === 'ox').length;
        const needsRegeneration = existingQuizzes.length === 0
          || existingChoiceCount !== quizOptions.choiceCount
          || existingOxCount !== quizOptions.oxCount;

        if (needsRegeneration) {
          const content = await c.env.DB
            .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1')
            .bind(contentId)
            .first();
          if (content?.content && content.content.trim().length >= 100) {
            // 기존 퀴즈가 있으면 삭제 후 재생성
            if (existingQuizzes.length > 0) {
              console.log(`[Session] Quiz count mismatch for content ${contentId}: choice ${existingChoiceCount}→${quizOptions.choiceCount}, ox ${existingOxCount}→${quizOptions.oxCount}. Regenerating.`);
              await c.env.DB
                .prepare('UPDATE TB_QUIZ SET status = -1 WHERE content_id = ? AND status = 1')
                .bind(contentId)
                .run();
            }
            quizPromises.push(
              quizService.generateQuizzesForContent(contentId, content.content, quizOptions)
                .catch(err => console.error('[Session] Quiz generation failed for content', contentId, err.message))
            );
          }
        }
      }
    }

    // 학습 데이터 + 퀴즈 생성 병렬 실행 (퀴즈 완료까지 대기)
    const learningService = new LearningService(c.env);
    const [learningData] = await Promise.all([
      learningService.generateAndStoreLearningData(sessionId, contentIds, settings),
      ...quizPromises
    ]);

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
        session: { id: sessionId, parentId: 0 },
        id: sessionId,
        parentId: 0,
        userId: session.user_id,
        title: learningData.sessionNm || '새 대화',
        settings: {
          persona: session.persona,
          temperature: session.temperature,
          topP: session.top_p,
          maxTokens: session.max_tokens,
          summaryCount: session.summary_count,
          recommendCount: session.recommend_count,
          choiceCount: session.choice_count,
          oxCount: session.ox_count,
          quizDifficulty: session.quiz_difficulty || 'normal'
        },
        learning: {
          goal: learningData.learningGoal,
          summary: learningData.learningSummary,
          recommendedQuestions: learningData.recommendedQuestions
        },
        contents: linkedContents || [],
        messages: [],
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

    // 자식 세션이면 부모의 콘텐츠/학습데이터 사용
    const isChild = session.parent_id > 0;
    let sourceSession = session;
    let contentSourceId = id;

    if (isChild) {
      const parentSession = await c.env.DB
        .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1')
        .bind(session.parent_id)
        .first();
      if (parentSession) {
        sourceSession = parentSession;
        contentSourceId = session.parent_id;
      }
    }

    // 메시지 조회 (자식 세션 자체의 채팅 기록)
    const { results: messages } = await c.env.DB
      .prepare(`
        SELECT id, role, content, created_at
        FROM TB_MESSAGE
        WHERE session_id = ? AND status = 1
        ORDER BY created_at ASC
      `)
      .bind(id)
      .all();

    // 연결된 콘텐츠 조회 (부모 또는 자기 자신)
    const { results: linkedContents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content_nm
        FROM TB_SESSION_CONTENT sc
        JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
        WHERE sc.session_id = ? AND sc.status = 1
      `)
      .bind(contentSourceId)
      .all();

    // 제목: 부모 세션 제목 우선, 없으면 첫 메시지 기반 생성
    let title = sourceSession.session_nm;
    if (!title) {
      const firstUserMessage = (messages || []).find(m => m.role === 'user');
      title = firstUserMessage
        ? firstUserMessage.content.substring(0, 30) + (firstUserMessage.content.length > 30 ? '...' : '')
        : '새 대화';
    }

    // 학습 요약 파싱 (부모의 데이터 사용)
    let learningSummary = null;
    if (sourceSession.learning_summary) {
      try {
        learningSummary = JSON.parse(sourceSession.learning_summary);
      } catch {
        learningSummary = sourceSession.learning_summary;
      }
    }

    // 추천 질문 파싱 (부모의 데이터 사용)
    let recommendedQuestions = [];
    if (sourceSession.recommended_questions) {
      try {
        recommendedQuestions = JSON.parse(sourceSession.recommended_questions);
      } catch {
        recommendedQuestions = [];
      }
    }

    return c.json({
      success: true,
      data: {
        id: session.id,
        parentId: session.parent_id,
        userId: session.user_id,
        title,
        settings: {
          persona: session.persona,
          temperature: session.temperature,
          topP: session.top_p,
          maxTokens: session.max_tokens,
          summaryCount: session.summary_count,
          recommendCount: session.recommend_count,
          choiceCount: session.choice_count,
          oxCount: session.ox_count,
          quizDifficulty: session.quiz_difficulty || 'normal'
        },
        learning: {
          goal: sourceSession.learning_goal || null,
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
    const choiceCount = settings.choiceCount !== undefined
      ? Math.max(0, Math.min(10, settings.choiceCount))
      : session.choice_count;
    const oxCount = settings.oxCount !== undefined
      ? Math.max(0, Math.min(10, settings.oxCount))
      : session.ox_count;
    const quizDifficulty = settings.quizDifficulty || session.quiz_difficulty || 'normal';

    // 세션 업데이트
    await c.env.DB
      .prepare(`
        UPDATE TB_SESSION
        SET persona = ?, temperature = ?, top_p = ?, max_tokens = ?,
            summary_count = ?, recommend_count = ?, choice_count = ?, ox_count = ?,
            quiz_difficulty = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(persona, temperature, topP, maxTokens, summaryCount, recommendCount, choiceCount, oxCount, quizDifficulty, id)
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
          choiceCount,
          oxCount,
          quizDifficulty
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
      .prepare('SELECT id, parent_id, choice_count, ox_count FROM TB_SESSION WHERE id = ? AND status = 1')
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

    // 자식 세션이면 부모의 콘텐츠로 퀴즈 조회
    const contentSourceId = session.parent_id > 0 ? session.parent_id : id;

    // 세션에 연결된 콘텐츠 ID 조회
    const { results: contents } = await c.env.DB
      .prepare(`
        SELECT content_id
        FROM TB_SESSION_CONTENT
        WHERE session_id = ? AND status = 1
      `)
      .bind(contentSourceId)
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
    const totalQuizLimit = (session.choice_count || 3) + (session.ox_count || 2);
    const quizzes = await quizService.getQuizzesByContentIds(contentIds, totalQuizLimit);

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

    // 자식 세션이면 부모의 콘텐츠로 퀴즈 재생성
    const contentSourceId = session.parent_id > 0 ? session.parent_id : id;

    // 연결된 콘텐츠 조회 (content 포함)
    const { results: contents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content
        FROM TB_CONTENT c
        JOIN TB_SESSION_CONTENT sc ON c.id = sc.content_id
        WHERE sc.session_id = ? AND sc.status = 1 AND c.status = 1
      `)
      .bind(contentSourceId)
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

    // 요청 본문에서 퀴즈 옵션 추출 (기본값: 세션 설정)
    let quizOptions = {
      choiceCount: session.choice_count ?? 3,
      oxCount: session.ox_count ?? 2
    };
    try {
      const body = await c.req.json();
      // 새로운 형식: choiceCount, oxCount
      if (body.choiceCount !== undefined || body.oxCount !== undefined) {
        quizOptions = {
          choiceCount: Math.max(0, Math.min(10, body.choiceCount ?? session.choice_count ?? 3)),
          oxCount: Math.max(0, Math.min(10, body.oxCount ?? session.ox_count ?? 2))
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
      .prepare('SELECT id, parent_id FROM TB_SESSION WHERE id = ? AND status = 1')
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

    // 부모 세션 삭제 시 자식 세션도 연쇄 삭제
    if (session.parent_id === 0) {
      const { results: children } = await c.env.DB
        .prepare('SELECT id FROM TB_SESSION WHERE parent_id = ? AND status = 1')
        .bind(id)
        .all();

      for (const child of (children || [])) {
        await c.env.DB
          .prepare('UPDATE TB_MESSAGE SET status = -1 WHERE session_id = ?')
          .bind(child.id)
          .run();
        await c.env.DB
          .prepare('UPDATE TB_SESSION SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(child.id)
          .run();
      }
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
