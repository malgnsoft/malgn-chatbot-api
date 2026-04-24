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
import { ContentService } from '../services/contentService.js';

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
    const siteId = c.get('siteId');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')));
    const offset = (page - 1) * limit;
    const generationStatus = c.req.query('generationStatus') || null;

    // 동적 WHERE 절 구성 (콤마 구분 복수 값 지원: pending,processing)
    const validStatuses = ['none', 'pending', 'processing', 'completed', 'failed'];
    let statusFilter = '';
    const binds = [siteId];
    if (generationStatus) {
      const statuses = generationStatus.split(',').map(s => s.trim()).filter(s => validStatuses.includes(s));
      if (statuses.length === 1) {
        statusFilter = ' AND s.generation_status = ?';
        binds.push(statuses[0]);
      } else if (statuses.length > 1) {
        statusFilter = ` AND s.generation_status IN (${statuses.map(() => '?').join(',')})`;
        binds.push(...statuses);
      }
    }

    // 전체 개수 조회 (부모 세션만, status = 1)
    const countResult = await c.env.DB
      .prepare(`SELECT COUNT(*) as total FROM TB_SESSION s WHERE s.status = 1 AND s.parent_id = 0 AND s.site_id = ?${statusFilter}`)
      .bind(...binds)
      .first();
    const total = countResult?.total || 0;

    // 세션 목록 조회 (status = 1만, 메시지도 status = 1만)
    const { results } = await c.env.DB
      .prepare(`
        SELECT
          s.id,
          s.session_nm,
          s.lesson_id,
          s.course_id,
          s.user_id,
          s.generation_status,
          s.learning_goal IS NOT NULL as hasLearningData,
          s.created_at,
          s.updated_at,
          (SELECT content FROM TB_MESSAGE WHERE session_id = s.id AND status = 1 ORDER BY created_at ASC LIMIT 1) as firstMessage,
          (SELECT content FROM TB_MESSAGE WHERE session_id = s.id AND status = 1 ORDER BY created_at DESC LIMIT 1) as lastMessage,
          (SELECT COUNT(*) FROM TB_MESSAGE WHERE session_id = s.id AND status = 1) as messageCount,
          (SELECT COUNT(*) FROM TB_SESSION_CONTENT WHERE session_id = s.id AND status = 1) as contentCount,
          (SELECT COUNT(*) FROM TB_SESSION WHERE parent_id = s.id AND status = 1) as childCount
        FROM TB_SESSION s
        WHERE s.status = 1 AND s.parent_id = 0 AND s.site_id = ?${statusFilter}
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(...binds, limit, offset)
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
        lessonId: session.lesson_id,
        courseId: session.course_id,
        userId: session.user_id,
        generationStatus: session.generation_status || 'none',
        hasLearningData: !!session.hasLearningData,
        contentCount: session.contentCount || 0,
        childCount: session.childCount || 0,
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
    let chatContentIds = null;
    let settings = {};
    let parentId = 0;
    let body = {};

    try {
      body = await c.req.json();
      console.log('[Session POST] body:', JSON.stringify(body));
      userId = (body.userId ?? body.user_id) != null ? parseInt(body.userId ?? body.user_id, 10) : null;
      courseId = body.courseId || body.course_id || null;
      courseUserId = body.courseUserId || body.course_user_id || null;
      lessonId = body.lessonId || body.lesson_id || null;
      contentIds = Array.isArray(body.contentIds) ? body.contentIds : (Array.isArray(body.content_ids) ? body.content_ids : []);
      chatContentIds = Array.isArray(body.chatContentIds) ? body.chatContentIds : (Array.isArray(body.chat_content_ids) ? body.chat_content_ids : null);
      settings = typeof body.settings === 'string' ? JSON.parse(body.settings) : (body.settings || {});
      parentId = body.parentId || body.parent_id || 0;
      console.log('[Session POST] parsed settings:', JSON.stringify(settings));
    } catch (e) {
      console.error('[Session POST] body parse error:', e.message);
    }

    const siteId = c.get('siteId');

    // ── 자식 세션 생성 (parent_id > 0) ──
    if (parentId > 0) {
      // 부모 세션 존재 확인
      const parentSession = await c.env.DB
        .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND parent_id = 0 AND site_id = ?')
        .bind(parentId, siteId)
        .first();

      if (!parentSession) {
        return c.json({
          success: false,
          error: { code: 'NOT_FOUND', message: '부모 세션을 찾을 수 없습니다.' }
        }, 404);
      }

      // 동일 부모 + 수강생 + 레슨 자식 존재 확인
      if (courseUserId) {
        let existingChildQuery = 'SELECT id FROM TB_SESSION WHERE parent_id = ? AND course_user_id = ? AND status = 1 AND site_id = ?';
        const bindParams = [parentId, courseUserId, siteId];
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
            .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
            .bind(existingChild.id, siteId)
            .first();

          const { results: messages } = await c.env.DB
            .prepare('SELECT id, role, content, created_at FROM TB_MESSAGE WHERE session_id = ? AND status = 1 AND site_id = ? ORDER BY created_at ASC')
            .bind(existingChild.id, siteId)
            .all();

          const { results: linkedContents } = await c.env.DB
            .prepare(`
              SELECT c.id, c.content_nm
              FROM TB_SESSION_CONTENT sc
              JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
              WHERE sc.session_id = ? AND sc.status = 1 AND sc.site_id = ?
            `)
            .bind(parentId, siteId)
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
            persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count, chat_content_ids, site_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          parentSession.ox_count,
          parentSession.chat_content_ids || null,
          siteId
        )
        .run();

      const childSessionId = insertResult.meta.last_row_id;

      // 부모의 콘텐츠 목록 조회
      const { results: linkedContents } = await c.env.DB
        .prepare(`
          SELECT c.id, c.content_nm
          FROM TB_SESSION_CONTENT sc
          JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
          WHERE sc.session_id = ? AND sc.status = 1 AND sc.site_id = ?
        `)
        .bind(parentId, siteId)
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

    // 세션 생성 (AI 설정 포함, 미전달 시 DB DEFAULT 사용) — 동기 처리만 지원
    const sessionNm = body.sessionNm || body.session_nm || null;
    const defaultPersona = '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변해 주세요.';
    const insertResult = await c.env.DB
      .prepare(`
        INSERT INTO TB_SESSION (parent_id, course_id, course_user_id, lesson_id, user_id, session_nm, persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count, quiz_difficulty, chat_content_ids, site_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        0,
        courseId,
        courseUserId,
        lessonId,
        userId,
        sessionNm,
        settings.persona || defaultPersona,
        settings.temperature ?? 0.3,
        settings.topP ?? 0.3,
        settings.maxTokens ?? 1024,
        settings.summaryCount ?? 3,
        settings.recommendCount ?? 3,
        settings.choiceCount ?? 3,
        settings.oxCount ?? 2,
        settings.quizDifficulty || 'normal',
        chatContentIds ? JSON.stringify(chatContentIds) : null,
        siteId
      )
      .run();

    const sessionId = insertResult.meta.last_row_id;

    // 콘텐츠 연결 (TB_SESSION_CONTENT)
    if (contentIds.length > 0) {
      for (const contentId of contentIds) {
        await c.env.DB
          .prepare('INSERT INTO TB_SESSION_CONTENT (session_id, content_id, site_id) VALUES (?, ?, ?)')
          .bind(sessionId, contentId, siteId)
          .run();
      }
    }

    // 퀴즈 생성 준비 (퀴즈 수가 0이면 스킵) — 세션 전체 기준으로 설정 수만큼만 생성
    const quizService = new QuizService(c.env, siteId);
    quizService.setContext(sessionId, lessonId);
    const totalQuizCount = (settings.choiceCount ?? 3) + (settings.oxCount ?? 2);
    const quizOptions = {
      choiceCount: settings.choiceCount ?? 3,
      oxCount: settings.oxCount ?? 2,
      difficulty: settings.quizDifficulty || 'normal'
    };

    let quizPromise = null;
    if (totalQuizCount > 0) {
      // 모든 콘텐츠 텍스트를 합쳐서 세션 전체 기준으로 퀴즈 생성
      const contentTexts = [];
      for (const contentId of contentIds) {
        const content = await c.env.DB
          .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1 AND site_id = ?')
          .bind(contentId, siteId)
          .first();
        if (content?.content && content.content.trim().length >= 100) {
          contentTexts.push(content.content);
        }
      }
      const mergedContent = contentTexts.join('\n\n---\n\n');
      if (mergedContent.trim().length >= 100) {
        quizPromise = quizService.generateQuizzesForContent(contentIds[0], mergedContent, quizOptions, sessionId)
          .catch(err => console.error('[Session] Quiz generation failed:', err.message));
      }
    }

    // 학습 데이터 + 퀴즈 생성 병렬 실행 (퀴즈 완료까지 대기)
    const learningService = new LearningService(c.env, siteId);
    learningService.setContext(sessionId, lessonId);
    const parallelTasks = [learningService.generateAndStoreLearningData(sessionId, contentIds, settings)];
    if (quizPromise) parallelTasks.push(quizPromise);
    const [learningData] = await Promise.all(parallelTasks);

    // 생성된 세션 조회 (학습 데이터 포함)
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND site_id = ?')
      .bind(sessionId, siteId)
      .first();

    // 연결된 콘텐츠 조회
    const { results: linkedContents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content_nm
        FROM TB_SESSION_CONTENT sc
        JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
        WHERE sc.session_id = ? AND sc.status = 1 AND sc.site_id = ?
      `)
      .bind(sessionId, siteId)
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
        message: '세션 생성 중 오류가 발생했습니다.',
        detail: error.message
      }
    }, 500);
  }
});

/**
 * POST /sessions/create-with-contents
 * 콘텐츠 등록 + 세션 생성 일괄 처리
 *
 * Body:
 * {
 *   contents: [
 *     { type: "link", url: "https://...", name: "자막 VTT" },
 *     { type: "link", url: "https://...", name: "교안 PDF" },
 *     { type: "text", name: "제목", content: "본문 텍스트" }
 *   ],
 *   settings: { persona, temperature, topP, maxTokens, summaryCount, recommendCount, choiceCount, oxCount, quizDifficulty },
 *   courseId, courseUserId, lessonId, userId, sessionNm,
 *   callbackUrl: "https://lms.example.com/api/callback" (선택 - 있으면 Queue 비동기 처리),
 *   callbackData: { ... } (선택 - 콜백 시 그대로 반환)
 * }
 */
sessions.post('/create-with-contents', async (c) => {
  try {
    const body = await c.req.json();
    console.log('[CreateWithContents] body:', JSON.stringify(body));

    const contents = typeof body.contents === 'string' ? JSON.parse(body.contents) : (body.contents || []);
    const userId = (body.userId ?? body.user_id) != null ? parseInt(body.userId ?? body.user_id, 10) : null;
    const courseId = body.courseId || body.course_id || null;
    const courseUserId = body.courseUserId || body.course_user_id || null;
    const lessonId = body.lessonId || body.lesson_id || null;
    const sessionNm = body.sessionNm || body.session_nm || null;
    const chatContentIds = Array.isArray(body.chatContentIds) ? body.chatContentIds : (Array.isArray(body.chat_content_ids) ? body.chat_content_ids : null);
    const settings = typeof body.settings === 'string' ? JSON.parse(body.settings) : (body.settings || {});
    const callbackUrl = body.callbackUrl || null;
    const callbackData = body.callbackData || null;

    if (!contents || contents.length === 0) {
      return c.json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '최소 하나 이상의 콘텐츠가 필요합니다.' }
      }, 400);
    }

    const siteId = c.get('siteId');

    // 1단계: 콘텐츠 등록 (병렬)
    const contentService = new ContentService(c.env, c.executionCtx, siteId);
    const contentResults = await Promise.all(
      contents.map(async (item, index) => {
        try {
          let result;
          if ((item.type === 'link' || item.type === 'link-subtitle' || item.type === 'link-file') && item.url) {
            result = await contentService.uploadLink(item.title || item.name || item.url, item.url, lessonId);
          } else if (item.type === 'text' && item.content) {
            result = await contentService.uploadText(item.title || item.name || '텍스트', item.content, lessonId);
          } else {
            return { index, inputName: item.title || item.name || item.url, inputType: item.type, error: `지원하지 않는 콘텐츠 타입: ${item.type}` };
          }
          // 요청 원본 정보 + 생성 결과 병합
          return { ...result, index, inputName: item.title || item.name || null, inputType: item.type, inputUrl: item.url || null };
        } catch (err) {
          return { index, inputName: item.title || item.name || item.url, inputType: item.type, inputUrl: item.url || null, error: err.message };
        }
      })
    );

    // 성공/실패 분리
    const successContents = contentResults.filter(r => r.id);
    const contentIds = successContents.map(r => r.id);
    const errors = contentResults.filter(r => r.error);

    if (contentIds.length === 0) {
      return c.json({
        success: false,
        error: {
          code: 'CONTENT_ERROR',
          message: '모든 콘텐츠 등록에 실패했습니다.',
          detail: errors
        }
      }, 400);
    }

    // 2단계: 세션 생성
    const useQueue = !!callbackUrl && !!c.env.QUEUE;
    const defaultPersona = '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변해 주세요.';
    const insertResult = await c.env.DB
      .prepare(`
        INSERT INTO TB_SESSION (parent_id, course_id, course_user_id, lesson_id, user_id, session_nm, persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count, quiz_difficulty, chat_content_ids, generation_status, site_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        0,
        courseId,
        courseUserId,
        lessonId,
        userId,
        sessionNm,
        settings.persona || defaultPersona,
        settings.temperature ?? 0.3,
        settings.topP ?? 0.3,
        settings.maxTokens ?? 1024,
        settings.summaryCount ?? 3,
        settings.recommendCount ?? 3,
        settings.choiceCount ?? 3,
        settings.oxCount ?? 2,
        settings.quizDifficulty || 'normal',
        chatContentIds ? JSON.stringify(chatContentIds) : null,
        useQueue ? 'pending' : 'none',
        siteId
      )
      .run();

    const sessionId = insertResult.meta.last_row_id;

    // 콘텐츠 연결 (TB_SESSION_CONTENT)
    for (const contentId of contentIds) {
      await c.env.DB
        .prepare('INSERT INTO TB_SESSION_CONTENT (session_id, content_id, site_id) VALUES (?, ?, ?)')
        .bind(sessionId, contentId, siteId)
        .run();
    }

    // ── 3단계: Queue(비동기) 또는 동기 처리 분기 ──
    if (useQueue) {
      // D1에 세션 + 콘텐츠 동기화 (Queue consumer가 D1을 사용하므로)
      if (c.env.D1_DB) {
        try {
          await c.env.D1_DB.prepare(`INSERT OR REPLACE INTO TB_SESSION (id, parent_id, course_id, course_user_id, lesson_id, user_id, session_nm, persona, temperature, top_p, max_tokens, summary_count, recommend_count, choice_count, ox_count, quiz_difficulty, chat_content_ids, generation_status, site_id, status, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
            .bind(sessionId, courseId, courseUserId, lessonId, userId, sessionNm, settings.persona || defaultPersona, settings.temperature ?? 0.3, settings.topP ?? 0.3, settings.maxTokens ?? 1024, settings.summaryCount ?? 3, settings.recommendCount ?? 3, settings.choiceCount ?? 3, settings.oxCount ?? 2, settings.quizDifficulty || 'normal', chatContentIds ? JSON.stringify(chatContentIds) : null, siteId).run();
          for (const contentId of contentIds) {
            await c.env.D1_DB.prepare('INSERT OR IGNORE INTO TB_SESSION_CONTENT (session_id, content_id, site_id, status) VALUES (?, ?, ?, 1)')
              .bind(sessionId, contentId, siteId).run();
          }
          // 콘텐츠 본문도 D1에 필요 (학습 데이터 생성 시 읽으므로)
          for (const contentId of contentIds) {
            const exists = await c.env.D1_DB.prepare('SELECT id FROM TB_CONTENT WHERE id = ?').bind(contentId).first();
            if (!exists) {
              const pgContent = await c.env.DB.prepare('SELECT * FROM TB_CONTENT WHERE id = ?').bind(contentId).first();
              if (pgContent) {
                await c.env.D1_DB.prepare('INSERT OR REPLACE INTO TB_CONTENT (id, content_nm, filename, file_type, file_size, content, lesson_id, site_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                  .bind(pgContent.id, pgContent.content_nm, pgContent.filename || '', pgContent.file_type || 'text', pgContent.file_size || 0, pgContent.content, pgContent.lesson_id, pgContent.site_id, pgContent.status, pgContent.created_at, pgContent.updated_at).run();
              }
            }
          }
        } catch (d1Err) {
          console.error('[CreateWithContents] D1 sync error:', d1Err.message);
        }
      }

      // Queue에 메시지 전송 → 즉시 응답
      await c.env.QUEUE.send({
        type: 'session-generation',
        sessionId,
        contentIds,
        contents: successContents.map(r => ({
          id: r.id,
          index: r.index,
          title: r.title,
          inputName: r.inputName,
          inputType: r.inputType,
          inputUrl: r.inputUrl,
          type: r.type
        })),
        settings,
        siteId,
        courseId,
        courseUserId,
        lessonId,
        userId,
        callbackUrl,
        callbackData
      });

      return c.json({
        success: true,
        data: {
          sessionId,
          siteId,
          generationStatus: 'pending',
          contents: successContents.map(r => ({
            id: r.id,
            index: r.index,
            title: r.title,
            inputName: r.inputName,
            inputType: r.inputType,
            inputUrl: r.inputUrl,
            type: r.type
          })),
          contentErrors: errors.length > 0 ? errors : undefined
        },
        message: '세션이 등록되었습니다. 생성 완료 시 콜백으로 알림합니다.'
      }, 202);
    }

    // ── 동기 처리 (callbackUrl 없을 때, 기존 로직) ──
    const quizService = new QuizService(c.env, siteId);
    quizService.setContext(sessionId, lessonId);
    const learningService = new LearningService(c.env, siteId);
    learningService.setContext(sessionId, lessonId);
    const totalQuizCount = (settings.choiceCount ?? 3) + (settings.oxCount ?? 2);
    const quizOptions = {
      choiceCount: settings.choiceCount ?? 3,
      oxCount: settings.oxCount ?? 2,
      difficulty: settings.quizDifficulty || 'normal'
    };

    const parallelTasks = [
      learningService.generateAndStoreLearningData(sessionId, contentIds, settings)
    ];

    if (totalQuizCount > 0) {
      const contentTexts = [];
      for (const contentId of contentIds) {
        const content = await c.env.DB
          .prepare('SELECT content FROM TB_CONTENT WHERE id = ? AND status = 1 AND site_id = ?')
          .bind(contentId, siteId)
          .first();
        if (content?.content && content.content.trim().length >= 100) {
          contentTexts.push(content.content);
        }
      }
      const mergedContent = contentTexts.join('\n\n---\n\n');
      if (mergedContent.trim().length >= 100) {
        parallelTasks.push(
          quizService.generateQuizzesForContent(contentIds[0], mergedContent, quizOptions, sessionId)
            .catch(err => console.error('[CreateWithContents] Quiz generation failed:', err.message))
        );
      }
    }

    const [learningData] = await Promise.all(parallelTasks);

    // 세션 조회
    const session = await c.env.DB
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND site_id = ?')
      .bind(sessionId, siteId)
      .first();

    return c.json({
      success: true,
      data: {
        sessionId,
        generationStatus: 'none',
        title: learningData.sessionNm || sessionNm || '새 대화',
        contents: successContents.map(r => ({
          id: r.id,
          index: r.index,
          title: r.title,
          inputName: r.inputName,
          inputType: r.inputType,
          inputUrl: r.inputUrl,
          type: r.type
        })),
        settings: {
          persona: session.persona,
          temperature: session.temperature,
          topP: session.top_p,
          maxTokens: session.max_tokens,
          choiceCount: session.choice_count,
          oxCount: session.ox_count,
          quizDifficulty: session.quiz_difficulty || 'normal'
        },
        learning: {
          goal: learningData.learningGoal,
          summary: learningData.learningSummary,
          recommendedQuestions: learningData.recommendedQuestions
        },
        contentErrors: errors.length > 0 ? errors : undefined
      },
      message: `세션 생성 완료. 콘텐츠 ${contentIds.length}개 등록, 학습 데이터/퀴즈 생성 완료.`
    }, 201);

  } catch (error) {
    console.error('Create with contents error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '일괄 생성 중 오류가 발생했습니다.',
        detail: error.message
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
    const siteId = c.get('siteId');
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
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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
        .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
        .bind(session.parent_id, siteId)
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
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY created_at ASC
      `)
      .bind(id, siteId)
      .all();

    // 연결된 콘텐츠 조회 (부모 또는 자기 자신)
    const { results: linkedContents } = await c.env.DB
      .prepare(`
        SELECT c.id, c.content_nm
        FROM TB_SESSION_CONTENT sc
        JOIN TB_CONTENT c ON sc.content_id = c.id AND c.status = 1
        WHERE sc.session_id = ? AND sc.status = 1 AND sc.site_id = ?
      `)
      .bind(contentSourceId, siteId)
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
    const siteId = c.get('siteId');
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
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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

    // 세션 기본 정보
    const sessionNm = settings.sessionNm !== undefined ? settings.sessionNm : session.session_nm;

    // AI 설정 값 검증 및 기본값 적용
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

    // 학습 메타데이터 (전달된 경우에만 업데이트, null 전달 시 초기화 가능)
    const learningGoal = settings.learningGoal !== undefined
      ? settings.learningGoal
      : session.learning_goal;
    const learningSummary = settings.learningSummary !== undefined
      ? (typeof settings.learningSummary === 'object' ? JSON.stringify(settings.learningSummary) : settings.learningSummary)
      : session.learning_summary;
    const recommendedQuestions = settings.recommendedQuestions !== undefined
      ? (typeof settings.recommendedQuestions === 'object' ? JSON.stringify(settings.recommendedQuestions) : settings.recommendedQuestions)
      : session.recommended_questions;

    // 세션 업데이트
    await c.env.DB
      .prepare(`
        UPDATE TB_SESSION
        SET session_nm = ?, persona = ?, temperature = ?, top_p = ?, max_tokens = ?,
            summary_count = ?, recommend_count = ?, choice_count = ?, ox_count = ?,
            quiz_difficulty = ?,
            learning_goal = ?, learning_summary = ?, recommended_questions = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND site_id = ?
      `)
      .bind(sessionNm, persona, temperature, topP, maxTokens, summaryCount, recommendCount, choiceCount, oxCount, quizDifficulty, learningGoal, learningSummary, recommendedQuestions, id, siteId)
      .run();

    return c.json({
      success: true,
      data: {
        id,
        sessionNm,
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
        },
        learning: {
          learningGoal,
          learningSummary,
          recommendedQuestions
        }
      },
      message: '세션이 업데이트되었습니다.'
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
 * PUT /sessions/:id/learning-goal
 * 학습 목표 업데이트
 */
sessions.put('/:id/learning-goal', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id) || id <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 세션 ID가 필요합니다.' } }, 400);
    }

    const session = await c.env.DB.prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?').bind(id, siteId).first();
    if (!session) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' } }, 404);
    }

    const body = await c.req.json();
    if (body.learningGoal === undefined) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'learningGoal 필드는 필수입니다.' } }, 400);
    }

    const learningGoal = body.learningGoal;
    await c.env.DB.prepare('UPDATE TB_SESSION SET learning_goal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?').bind(learningGoal, id, siteId).run();

    return c.json({ success: true, data: { id, learningGoal }, message: '학습 목표가 업데이트되었습니다.' });
  } catch (error) {
    console.error('Update learning goal error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '학습 목표 업데이트 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * PUT /sessions/:id/learning-summary
 * 학습 요약 업데이트
 */
sessions.put('/:id/learning-summary', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id) || id <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 세션 ID가 필요합니다.' } }, 400);
    }

    const session = await c.env.DB.prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?').bind(id, siteId).first();
    if (!session) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' } }, 404);
    }

    const body = await c.req.json();
    if (body.learningSummary === undefined) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'learningSummary 필드는 필수입니다.' } }, 400);
    }

    const learningSummary = typeof body.learningSummary === 'object' ? JSON.stringify(body.learningSummary) : body.learningSummary;
    await c.env.DB.prepare('UPDATE TB_SESSION SET learning_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?').bind(learningSummary, id, siteId).run();

    return c.json({ success: true, data: { id, learningSummary }, message: '학습 요약이 업데이트되었습니다.' });
  } catch (error) {
    console.error('Update learning summary error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '학습 요약 업데이트 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * PUT /sessions/:id/recommended-questions
 * 추천 질문 업데이트
 */
sessions.put('/:id/recommended-questions', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id) || id <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 세션 ID가 필요합니다.' } }, 400);
    }

    const session = await c.env.DB.prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?').bind(id, siteId).first();
    if (!session) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' } }, 404);
    }

    const body = await c.req.json();
    if (body.recommendedQuestions === undefined) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'recommendedQuestions 필드는 필수입니다.' } }, 400);
    }

    const recommendedQuestions = typeof body.recommendedQuestions === 'object' ? JSON.stringify(body.recommendedQuestions) : body.recommendedQuestions;
    await c.env.DB.prepare('UPDATE TB_SESSION SET recommended_questions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?').bind(recommendedQuestions, id, siteId).run();

    return c.json({ success: true, data: { id, recommendedQuestions }, message: '추천 질문이 업데이트되었습니다.' });
  } catch (error) {
    console.error('Update recommended questions error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '추천 질문 업데이트 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * GET /sessions/:id/quizzes
 * 세션에 연결된 콘텐츠의 퀴즈 조회
 */
sessions.get('/:id/quizzes', async (c) => {
  try {
    const siteId = c.get('siteId');
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
      .prepare('SELECT id, parent_id, choice_count, ox_count FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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

    // 자식 세션이면 부모 세션의 퀴즈 조회
    const quizSessionId = session.parent_id > 0 ? session.parent_id : id;

    // 세션 기준 퀴즈 조회
    const quizService = new QuizService(c.env, siteId);
    const quizzes = await quizService.getQuizzesBySession(quizSessionId);

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
 * PUT /sessions/:id/quizzes/reorder
 * 세션 퀴즈 순서 재정렬
 *
 * Body 불필요 - 세션의 모든 퀴즈를 4지선다 → OX 순서로 자동 정렬
 */
sessions.put('/:id/quizzes/reorder', async (c) => {
  try {
    const siteId = c.get('siteId');
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

    // 세션 존재 확인
    const session = await c.env.DB
      .prepare('SELECT id, parent_id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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

    const quizSessionId = session.parent_id > 0 ? session.parent_id : id;

    // 세션의 모든 퀴즈 조회 (4지선다 → OX, 생성일 순)
    const { results: quizzes } = await c.env.DB
      .prepare(`
        SELECT id FROM TB_QUIZ
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC, created_at ASC
      `)
      .bind(quizSessionId, siteId)
      .all();

    if (!quizzes || quizzes.length === 0) {
      return c.json({
        success: true,
        data: { sessionId: id, reordered: 0 }
      });
    }

    // position 순차 갱신
    const updates = quizzes.map((quiz, index) =>
      c.env.DB
        .prepare('UPDATE TB_QUIZ SET position = ? WHERE id = ?')
        .bind(index + 1, quiz.id)
        .run()
    );

    await Promise.all(updates);

    return c.json({
      success: true,
      data: {
        sessionId: id,
        reordered: quizzes.length
      }
    });

  } catch (error) {
    console.error('Reorder quizzes error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '퀴즈 순서 변경 중 오류가 발생했습니다.'
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
    const siteId = c.get('siteId');
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
      .prepare('SELECT * FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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
        WHERE sc.session_id = ? AND sc.status = 1 AND c.status = 1 AND sc.site_id = ?
      `)
      .bind(contentSourceId, siteId)
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

    const quizService = new QuizService(c.env, siteId);
    quizService.setContext(id, session.lesson_id);
    const allQuizzes = [];

    // 기존 세션 퀴즈 삭제 (세션 기준)
    await c.env.DB
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE session_id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
      .run();

    // 각 콘텐츠별로 퀴즈 재생성 (세션에 귀속)
    for (const content of contents) {
      if (content.content && content.content.trim().length > 0) {
        const quizzes = await quizService.generateQuizzesForContent(
          content.id,
          content.content,
          quizOptions,
          id
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
 * POST /sessions/:id/quiz
 * 세션에 퀴즈 직접 추가
 */
sessions.post('/:id/quiz', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id) || id <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 세션 ID가 필요합니다.' } }, 400);
    }

    const session = await c.env.DB.prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?').bind(id, siteId).first();
    if (!session) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' } }, 404);
    }

    const body = await c.req.json();
    const { quizType, question, options, answer, explanation, position } = body;

    // 필수 필드 검증
    if (!quizType || !['choice', 'ox'].includes(quizType)) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'quizType은 choice 또는 ox이어야 합니다.' } }, 400);
    }
    if (!question || question.trim().length === 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'question은 필수입니다.' } }, 400);
    }
    if (!answer || answer.trim().length === 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'answer는 필수입니다.' } }, 400);
    }
    if (quizType === 'choice' && (!options || !Array.isArray(options) || options.length !== 4)) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'choice 타입은 4개의 options 배열이 필수입니다.' } }, 400);
    }

    const quizService = new QuizService(c.env, siteId);
    const quiz = await quizService.addQuizToSession(id, { quizType, question, options, answer, explanation, position });

    // 퀴즈 추가 후 세션 퀴즈 재정렬 (4지선다 → OX, 생성일 순)
    const { results: allQuizzes } = await c.env.DB
      .prepare(`
        SELECT id FROM TB_QUIZ
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC, created_at ASC
      `)
      .bind(id, siteId)
      .all();

    if (allQuizzes && allQuizzes.length > 0) {
      await Promise.all(
        allQuizzes.map((q, index) =>
          c.env.DB.prepare('UPDATE TB_QUIZ SET position = ? WHERE id = ?').bind(index + 1, q.id).run()
        )
      );
    }

    return c.json({
      success: true,
      data: quiz,
      message: '퀴즈가 추가되었습니다.'
    }, 201);

  } catch (error) {
    console.error('Add session quiz error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '퀴즈 추가 중 오류가 발생했습니다.', detail: error.message } }, 500);
  }
});

/**
 * GET /sessions/:id/quiz/:quizId
 * 세션 퀴즈 단건 조회
 */
sessions.get('/:id/quiz/:quizId', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    const quizId = parseInt(c.req.param('quizId'), 10);

    if (isNaN(id) || id <= 0 || isNaN(quizId) || quizId <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 ID가 필요합니다.' } }, 400);
    }

    const session = await c.env.DB.prepare('SELECT id, parent_id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?').bind(id, siteId).first();
    if (!session) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' } }, 404);
    }

    const quizSessionId = session.parent_id > 0 ? session.parent_id : id;

    const quiz = await c.env.DB
      .prepare('SELECT id, session_id, content_id, quiz_type, question, options, answer, explanation, position, created_at FROM TB_QUIZ WHERE id = ? AND session_id = ? AND status = 1 AND site_id = ?')
      .bind(quizId, quizSessionId, siteId)
      .first();

    if (!quiz) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '퀴즈를 찾을 수 없습니다.' } }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: quiz.id,
        sessionId: quiz.session_id,
        contentId: quiz.content_id,
        quizType: quiz.quiz_type,
        question: quiz.question,
        options: quiz.options ? JSON.parse(quiz.options) : null,
        answer: quiz.answer,
        explanation: quiz.explanation,
        position: quiz.position,
        createdAt: quiz.created_at
      }
    });

  } catch (error) {
    console.error('Get session quiz error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '퀴즈 조회 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * PUT /sessions/:id/quiz/:quizId
 * 세션 퀴즈 수정
 */
sessions.put('/:id/quiz/:quizId', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    const quizId = parseInt(c.req.param('quizId'), 10);

    if (isNaN(id) || id <= 0 || isNaN(quizId) || quizId <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 ID가 필요합니다.' } }, 400);
    }

    const body = await c.req.json();
    const { quizType, question, options, answer, explanation, position } = body;

    if (quizType && !['choice', 'ox'].includes(quizType)) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'quizType은 choice 또는 ox이어야 합니다.' } }, 400);
    }
    if (quizType === 'choice' && options && (!Array.isArray(options) || options.length !== 4)) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'choice 타입은 4개의 options 배열이 필수입니다.' } }, 400);
    }

    const quizService = new QuizService(c.env, siteId);
    const updated = await quizService.updateSessionQuiz(quizId, id, { quizType, question, options, answer, explanation, position });

    if (!updated) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '해당 세션의 퀴즈를 찾을 수 없습니다.' } }, 404);
    }

    // 수정 후 세션 퀴즈 재정렬 (4지선다 → OX → position → 생성일 순)
    const { results: allQuizzes } = await c.env.DB
      .prepare(`
        SELECT id FROM TB_QUIZ
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC, created_at ASC
      `)
      .bind(id, siteId)
      .all();

    if (allQuizzes && allQuizzes.length > 0) {
      await Promise.all(
        allQuizzes.map((q, index) =>
          c.env.DB.prepare('UPDATE TB_QUIZ SET position = ? WHERE id = ?').bind(index + 1, q.id).run()
        )
      );
    }

    return c.json({ success: true, data: updated, message: '퀴즈가 수정되었습니다.' });

  } catch (error) {
    console.error('Update session quiz error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '퀴즈 수정 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * DELETE /sessions/:id/quiz/:quizId
 * 세션 퀴즈 삭제
 */
sessions.delete('/:id/quiz/:quizId', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);
    const quizId = parseInt(c.req.param('quizId'), 10);

    if (isNaN(id) || id <= 0 || isNaN(quizId) || quizId <= 0) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: '유효한 ID가 필요합니다.' } }, 400);
    }

    const quizService = new QuizService(c.env, siteId);
    const deleted = await quizService.deleteSessionQuiz(quizId, id);

    if (!deleted) {
      return c.json({ success: false, error: { code: 'NOT_FOUND', message: '해당 세션의 퀴즈를 찾을 수 없습니다.' } }, 404);
    }

    // 삭제 후 세션 퀴즈 재정렬 (position → 생성일 순)
    const { results: allQuizzes } = await c.env.DB
      .prepare(`
        SELECT id FROM TB_QUIZ
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC, created_at ASC
      `)
      .bind(id, siteId)
      .all();

    if (allQuizzes && allQuizzes.length > 0) {
      await Promise.all(
        allQuizzes.map((q, index) =>
          c.env.DB.prepare('UPDATE TB_QUIZ SET position = ? WHERE id = ?').bind(index + 1, q.id).run()
        )
      );
    }

    return c.json({ success: true, message: '퀴즈가 삭제되었습니다.' });

  } catch (error) {
    console.error('Delete session quiz error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '퀴즈 삭제 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * DELETE /sessions/:id/messages
 * 세션 메시지 초기화 (Soft Delete)
 */
sessions.delete('/:id/messages', async (c) => {
  try {
    const siteId = c.get('siteId');
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '유효한 세션 ID가 필요합니다.' }
      }, 400);
    }

    const session = await c.env.DB
      .prepare('SELECT id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
      .first();

    if (!session) {
      return c.json({
        success: false,
        error: { code: 'NOT_FOUND', message: '세션을 찾을 수 없습니다.' }
      }, 404);
    }

    await c.env.DB
      .prepare('UPDATE TB_MESSAGE SET status = -1 WHERE session_id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
      .run();

    return c.json({ success: true, message: '대화 내용이 초기화되었습니다.' });

  } catch (error) {
    console.error('Clear session messages error:', error);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: '메시지 초기화 중 오류가 발생했습니다.' } }, 500);
  }
});

/**
 * DELETE /sessions/:id
 * 세션 삭제 (Soft Delete)
 */
sessions.delete('/:id', async (c) => {
  try {
    const siteId = c.get('siteId');
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
      .prepare('SELECT id, parent_id FROM TB_SESSION WHERE id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
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
        .prepare('SELECT id FROM TB_SESSION WHERE parent_id = ? AND status = 1 AND site_id = ?')
        .bind(id, siteId)
        .all();

      for (const child of (children || [])) {
        await c.env.DB
          .prepare('UPDATE TB_MESSAGE SET status = -1 WHERE session_id = ? AND site_id = ?')
          .bind(child.id, siteId)
          .run();
        await c.env.DB
          .prepare('UPDATE TB_QUIZ SET status = -1 WHERE session_id = ? AND status = 1 AND site_id = ?')
          .bind(child.id, siteId)
          .run();
        await c.env.DB
          .prepare('UPDATE TB_SESSION SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?')
          .bind(child.id, siteId)
          .run();
      }
    }

    // 메시지 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_MESSAGE SET status = -1 WHERE session_id = ? AND site_id = ?')
      .bind(id, siteId)
      .run();

    // 세션-콘텐츠 연결 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_SESSION_CONTENT SET status = -1 WHERE session_id = ? AND site_id = ?')
      .bind(id, siteId)
      .run();

    // 세션 퀴즈 soft delete
    await c.env.DB
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE session_id = ? AND status = 1 AND site_id = ?')
      .bind(id, siteId)
      .run();

    // Vectorize에서 학습 임베딩 삭제
    const learningService = new LearningService(c.env, siteId);
    await learningService.deleteLearningEmbeddings(id);

    // 세션 soft delete (status = -1)
    await c.env.DB
      .prepare('UPDATE TB_SESSION SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?')
      .bind(id, siteId)
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
