/**
 * Contents Routes
 *
 * 콘텐츠 관리 API 엔드포인트
 * GET /contents - 콘텐츠 목록 조회
 * POST /contents - 콘텐츠 등록 (텍스트, 파일, 링크)
 * GET /contents/:id - 콘텐츠 상세 조회
 * DELETE /contents/:id - 콘텐츠 삭제
 *
 * 지원 형식:
 * - 텍스트: JSON { type: 'text', title, content }
 * - 파일: FormData { file, title }
 * - 링크: JSON { type: 'link', title, url }
 */
import { Hono } from 'hono';
import { ContentService } from '../services/contentService.js';

const contents = new Hono();

/**
 * GET /contents
 * 업로드된 콘텐츠 목록 조회
 *
 * Query Parameters:
 * - page: 페이지 번호 (기본값: 1)
 * - limit: 페이지당 개수 (기본값: 20, 최대: 100)
 */
contents.get('/', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')));

    const contentService = new ContentService(c.env);
    const result = await contentService.listContents(page, limit);

    return c.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('List contents error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 목록 조회 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * POST /contents
 * 새 콘텐츠 업로드
 *
 * 지원 형식:
 * 1. 텍스트 (JSON): { type: 'text', title, content }
 * 2. 링크 (JSON): { type: 'link', title, url }
 * 3. 파일 (FormData): file, title
 */
contents.post('/', async (c) => {
  try {
    const contentType = c.req.header('content-type') || '';
    const contentService = new ContentService(c.env, c.executionCtx);

    // JSON 요청 (텍스트 또는 링크)
    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      const { type, title, content, url } = body;

      if (type === 'text') {
        // 텍스트 콘텐츠 처리
        if (!title) {
          return c.json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'title 필드는 필수입니다.'
            }
          }, 400);
        }

        if (!content) {
          return c.json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'content 필드는 필수입니다.'
            }
          }, 400);
        }

        const result = await contentService.uploadText(title, content);
        return c.json({
          success: true,
          data: result,
          message: '텍스트가 성공적으로 추가되었습니다.'
        }, 201);

      } else if (type === 'link') {
        // 링크 콘텐츠 처리
        if (!title) {
          return c.json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'title 필드는 필수입니다.'
            }
          }, 400);
        }

        if (!url) {
          return c.json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'url 필드는 필수입니다.'
            }
          }, 400);
        }

        const result = await contentService.uploadLink(title, url);
        return c.json({
          success: true,
          data: result,
          message: '링크가 성공적으로 추가되었습니다.'
        }, 201);

      } else {
        return c.json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'type 필드는 text 또는 link여야 합니다.'
          }
        }, 400);
      }
    }

    // FormData 요청 (파일 업로드)
    const formData = await c.req.formData();
    const file = formData.get('file');
    const title = formData.get('title');

    // 파일 검증
    if (!file || !(file instanceof File)) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'file 필드는 필수입니다.'
        }
      }, 400);
    }

    // 파일 크기 검증 (10MB)
    if (file.size > 10 * 1024 * 1024) {
      return c.json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: '파일 크기가 너무 큽니다. (최대 10MB)'
        }
      }, 413);
    }

    // 파일 확장자 검증
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['pdf', 'txt', 'md', 'srt', 'vtt'].includes(ext)) {
      return c.json({
        success: false,
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          message: '지원하지 않는 파일 형식입니다. (지원: PDF, TXT, MD, SRT, VTT)'
        }
      }, 415);
    }

    // 콘텐츠 서비스 호출
    const result = await contentService.uploadFile(file, title);

    return c.json({
      success: true,
      data: result,
      message: '콘텐츠가 성공적으로 업로드되었습니다.'
    }, 201);

  } catch (error) {
    console.error('Upload content error:', error);

    // URL 관련 에러
    if (error.message.includes('URL')) {
      return c.json({
        success: false,
        error: {
          code: 'URL_ERROR',
          message: error.message
        }
      }, 400);
    }

    // 파일 형식 에러
    if (error.message.includes('지원하지 않는')) {
      return c.json({
        success: false,
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          message: error.message
        }
      }, 415);
    }

    // 파일 크기 에러
    if (error.message.includes('크기')) {
      return c.json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: error.message
        }
      }, 413);
    }

    // 텍스트 추출 에러
    if (error.message.includes('텍스트')) {
      return c.json({
        success: false,
        error: {
          code: 'EXTRACTION_ERROR',
          message: error.message
        }
      }, 400);
    }

    // 임베딩 에러
    if (error.message.includes('임베딩')) {
      return c.json({
        success: false,
        error: {
          code: 'EMBEDDING_ERROR',
          message: '콘텐츠 처리 중 오류가 발생했습니다.'
        }
      }, 500);
    }

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 업로드 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * POST /contents/regenerate-all-quizzes
 * 모든 콘텐츠에 대해 퀴즈 재생성 (퀴즈가 없는 콘텐츠만)
 * NOTE: 정적 라우트는 동적 라우트(/:id) 앞에 정의해야 함
 */
contents.post('/regenerate-all-quizzes', async (c) => {
  try {
    const contentService = new ContentService(c.env);
    const result = await contentService.regenerateAllQuizzes();

    return c.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Regenerate all quizzes error:', error);
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
 * POST /contents/reembed
 * 모든 콘텐츠 재임베딩 (Vectorize 인덱스 재생성 후 사용)
 * NOTE: 정적 라우트는 동적 라우트(/:id) 앞에 정의해야 함
 */
contents.post('/reembed', async (c) => {
  try {
    const contentService = new ContentService(c.env);
    const result = await contentService.reembedAllContents();

    return c.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Reembed contents error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 재임베딩 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * GET /contents/:id
 * 콘텐츠 상세 조회
 */
contents.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 콘텐츠 ID가 필요합니다.'
        }
      }, 400);
    }

    const contentService = new ContentService(c.env);
    const content = await contentService.getContent(id);

    if (!content) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '콘텐츠를 찾을 수 없습니다.'
        }
      }, 404);
    }

    return c.json({
      success: true,
      data: content
    });

  } catch (error) {
    console.error('Get content error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 조회 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * PUT /contents/:id
 * 콘텐츠 수정 (제목 및 내용)
 */
contents.put('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 콘텐츠 ID가 필요합니다.'
        }
      }, 400);
    }

    const body = await c.req.json();
    const { title, content } = body;

    if (!title || title.trim().length === 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'title 필드는 필수입니다.'
        }
      }, 400);
    }

    const contentService = new ContentService(c.env);
    const updated = await contentService.updateContent(id, title, content);

    if (!updated) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '콘텐츠를 찾을 수 없습니다.'
        }
      }, 404);
    }

    return c.json({
      success: true,
      data: updated,
      message: '콘텐츠가 성공적으로 수정되었습니다.'
    });

  } catch (error) {
    console.error('Update content error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 수정 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

/**
 * POST /contents/:id/quizzes
 * 특정 콘텐츠에 대해 퀴즈 재생성
 * Body: { choiceCount?: number, oxCount?: number } 또는 { count?: number }
 */
contents.post('/:id/quizzes', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 콘텐츠 ID가 필요합니다.'
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

    const contentService = new ContentService(c.env);
    const result = await contentService.regenerateQuizzes(id, quizOptions);

    if (!result) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '콘텐츠를 찾을 수 없습니다.'
        }
      }, 404);
    }

    return c.json({
      success: true,
      data: result,
      message: `${result.quizCount}개의 퀴즈가 생성되었습니다.`
    });

  } catch (error) {
    console.error('Regenerate quizzes error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: `퀴즈 생성 중 오류가 발생했습니다: ${error.message}`
      }
    }, 500);
  }
});

/**
 * GET /contents/:id/quizzes
 * 특정 콘텐츠의 퀴즈 목록 조회
 */
contents.get('/:id/quizzes', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 콘텐츠 ID가 필요합니다.'
        }
      }, 400);
    }

    const contentService = new ContentService(c.env);
    const quizzes = await contentService.getQuizzes(id);

    return c.json({
      success: true,
      data: {
        contentId: id,
        quizCount: quizzes.length,
        quizzes
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
 * DELETE /contents/:id
 * 콘텐츠 삭제
 */
contents.delete('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);

    if (isNaN(id) || id <= 0) {
      return c.json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '유효한 콘텐츠 ID가 필요합니다.'
        }
      }, 400);
    }

    const contentService = new ContentService(c.env);
    const deleted = await contentService.deleteContent(id);

    if (!deleted) {
      return c.json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '콘텐츠를 찾을 수 없습니다.'
        }
      }, 404);
    }

    return c.json({
      success: true,
      message: '콘텐츠가 성공적으로 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete content error:', error);
    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '콘텐츠 삭제 중 오류가 발생했습니다.'
      }
    }, 500);
  }
});

export default contents;
