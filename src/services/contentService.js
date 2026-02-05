/**
 * Content Service
 *
 * 콘텐츠 업로드, 조회, 삭제를 처리하는 서비스입니다.
 * - 파일에서 텍스트 추출
 * - D1에 전체 내용 저장
 * - Vectorize에 임베딩 저장
 */
import { EmbeddingService } from './embeddingService.js';
import { QuizService } from './quizService.js';

export class ContentService {
  constructor(env, executionCtx = null) {
    this.env = env;
    this.executionCtx = executionCtx;
    this.embeddingService = new EmbeddingService(env);
    this.quizService = new QuizService(env);
  }

  /**
   * 콘텐츠 목록 조회
   */
  async listContents(page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    // 전체 개수 조회 (status = 1만)
    const countResult = await this.env.DB
      .prepare('SELECT COUNT(*) as total FROM TB_CONTENT WHERE status = 1')
      .first();
    const total = countResult?.total || 0;

    // 콘텐츠 목록 조회 (status = 1만)
    const { results } = await this.env.DB
      .prepare(`
        SELECT id, content_nm, filename, file_type, file_size, status, created_at
        FROM TB_CONTENT
        WHERE status = 1
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(limit, offset)
      .all();

    return {
      contents: results || [],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * 콘텐츠 상세 조회
   */
  async getContent(id) {
    // 콘텐츠 조회 (status = 1만)
    const content = await this.env.DB
      .prepare('SELECT id, content_nm, filename, file_type, file_size, content, status, created_at, updated_at FROM TB_CONTENT WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!content) {
      return null;
    }

    return content;
  }

  /**
   * 텍스트 콘텐츠 업로드
   */
  async uploadText(title, content) {
    if (!title || title.trim().length === 0) {
      throw new Error('제목은 필수입니다.');
    }

    if (!content || content.trim().length === 0) {
      throw new Error('내용은 필수입니다.');
    }

    const contentTitle = title.trim();
    const contentText = content.trim();
    const contentSize = new TextEncoder().encode(contentText).length;

    // D1에 콘텐츠 저장
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, content)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, '', 'text', contentSize, contentText)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 임베딩 생성 및 Vectorize 저장
    await this.storeContentEmbedding(contentId, contentTitle, contentText);

    // 퀴즈 생성 (백그라운드로 실행, 실패해도 업로드는 성공)
    const quizPromise = this.generateQuizForContent(contentId, contentText).catch(err => {
      console.error('[ContentService] Quiz generation failed:', err.message);
    });
    if (this.executionCtx) {
      this.executionCtx.waitUntil(quizPromise);
    }

    return {
      id: contentId,
      title: contentTitle,
      type: 'text',
      fileSize: contentSize,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 링크 콘텐츠 업로드
   */
  async uploadLink(title, url) {
    if (!title || title.trim().length === 0) {
      throw new Error('제목은 필수입니다.');
    }

    if (!url || url.trim().length === 0) {
      throw new Error('URL은 필수입니다.');
    }

    // URL 유효성 검사
    try {
      new URL(url);
    } catch {
      throw new Error('올바른 URL 형식이 아닙니다.');
    }

    // URL에서 콘텐츠 가져오기
    let content;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MalgnBot/1.0)'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const urlLower = url.toLowerCase();

      // 자막 파일 확인 (URL 확장자 또는 content-type)
      const isSubtitle = urlLower.endsWith('.srt') ||
                         urlLower.endsWith('.vtt') ||
                         contentType.includes('text/vtt') ||
                         contentType.includes('application/x-subrip');

      if (isSubtitle) {
        // 자막 파일에서 텍스트 추출
        const subtitleText = await response.text();
        content = this.extractTextFromSubtitle(subtitleText);
      } else if (contentType.includes('text/html')) {
        // HTML에서 텍스트 추출
        const html = await response.text();
        content = this.extractTextFromHtml(html);
      } else if (contentType.includes('text/') || contentType.includes('application/json')) {
        content = await response.text();
      } else {
        throw new Error('지원하지 않는 콘텐츠 형식입니다. (텍스트 기반 콘텐츠만 지원)');
      }
    } catch (error) {
      throw new Error(`URL에서 콘텐츠를 가져올 수 없습니다: ${error.message}`);
    }

    if (!content || content.trim().length === 0) {
      throw new Error('URL에서 유효한 텍스트를 추출할 수 없습니다.');
    }

    const contentTitle = title.trim();
    const contentText = content.trim();
    const contentSize = new TextEncoder().encode(contentText).length;

    // D1에 콘텐츠 저장
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, content)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, url, 'link', contentSize, contentText)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 임베딩 생성 및 Vectorize 저장
    await this.storeContentEmbedding(contentId, contentTitle, contentText);

    // 퀴즈 생성 (백그라운드로 실행)
    const quizPromise = this.generateQuizForContent(contentId, contentText).catch(err => {
      console.error('[ContentService] Quiz generation failed:', err.message);
    });
    if (this.executionCtx) {
      this.executionCtx.waitUntil(quizPromise);
    }

    return {
      id: contentId,
      title: contentTitle,
      type: 'link',
      url,
      fileSize: contentSize,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * HTML에서 텍스트 추출
   */
  extractTextFromHtml(html) {
    // script, style 태그 제거
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

    // HTML 태그 제거
    text = text.replace(/<[^>]+>/g, ' ');

    // HTML 엔티티 디코딩
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(num));

    // 연속 공백 정리
    text = text.replace(/\s+/g, ' ').trim();

    return text;
  }

  /**
   * 자막 파일에서 텍스트 추출 (SRT, VTT 지원)
   */
  extractTextFromSubtitle(subtitleText) {
    const lines = subtitleText.split('\n');
    const textLines = [];

    // VTT 헤더 제거
    let startIndex = 0;
    if (lines[0]?.trim().startsWith('WEBVTT')) {
      startIndex = 1;
      // 헤더 메타데이터 스킵
      while (startIndex < lines.length && lines[startIndex].trim() !== '') {
        startIndex++;
      }
    }

    // 타임스탬프 패턴 (다양한 형식 지원)
    // 00:00:00,000 --> 00:00:00,000 (SRT)
    // 00:00:00.000 --> 00:00:00.000 (VTT with hours)
    // 00:00.000 --> 00:00.000 (VTT without hours)
    const timestampRegex = /^(\d{1,2}:)?\d{2}:\d{2}[,\.]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[,\.]\d{3}/;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();

      // 빈 줄 스킵
      if (!line) continue;

      // 자막 번호 스킵 (SRT 형식: 숫자만 있는 줄)
      if (/^\d+$/.test(line)) continue;

      // 타임스탬프 줄 스킵
      if (timestampRegex.test(line)) continue;

      // VTT 큐 ID 스킵 (숫자 또는 문자로 시작하고 타임스탬프가 아닌 경우)
      // 예: "1", "cue-1", etc. - 다음 줄이 타임스탬프인지 확인
      if (/^[\w-]+$/.test(line) && i + 1 < lines.length && timestampRegex.test(lines[i + 1]?.trim())) {
        continue;
      }

      // VTT 큐 설정 스킵 (align:, position: 등)
      if (/^(align|position|line|size|vertical):/.test(line)) continue;

      // NOTE, STYLE, REGION 블록 스킵 (VTT)
      if (/^(NOTE|STYLE|REGION)/.test(line)) continue;

      // HTML 태그 제거 (<b>, <i>, <u>, <font> 등)
      let cleanLine = line
        .replace(/<[^>]+>/g, '')
        .replace(/\{[^}]+\}/g, ''); // SSA/ASS 스타일 태그 제거

      if (cleanLine.trim()) {
        textLines.push(cleanLine.trim());
      }
    }

    // 중복 제거 없이 모든 줄 유지
    return textLines.join('\n');
  }

  /**
   * 파일 업로드 및 처리
   */
  async uploadFile(file, title = null) {
    // 파일 정보 추출
    const filename = file.name;
    const fileType = this.getFileType(filename);
    const fileSize = file.size;

    // 지원 형식 확인
    if (!['pdf', 'txt', 'md', 'srt', 'vtt'].includes(fileType)) {
      throw new Error('지원하지 않는 파일 형식입니다. (지원: PDF, TXT, MD, SRT, VTT)');
    }

    // 파일 크기 확인 (10MB 제한)
    const maxSize = fileType === 'pdf' ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (fileSize > maxSize) {
      throw new Error(`파일 크기가 너무 큽니다. (최대: ${maxSize / 1024 / 1024}MB)`);
    }

    // 텍스트 추출
    const text = await this.extractText(file, fileType);
    if (!text || text.trim().length === 0) {
      throw new Error('파일에서 텍스트를 추출할 수 없습니다.');
    }

    const contentTitle = title || filename.replace(/\.[^/.]+$/, '');
    const contentText = text.trim();

    // D1에 콘텐츠 저장
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, content)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, filename, fileType, fileSize, contentText)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 임베딩 생성 및 Vectorize 저장
    await this.storeContentEmbedding(contentId, contentTitle, contentText);

    // 퀴즈 생성 (백그라운드로 실행)
    const quizPromise = this.generateQuizForContent(contentId, contentText).catch(err => {
      console.error('[ContentService] Quiz generation failed:', err.message);
    });
    if (this.executionCtx) {
      this.executionCtx.waitUntil(quizPromise);
    }

    return {
      id: contentId,
      title: contentTitle,
      filename,
      fileType,
      fileSize,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 콘텐츠에 대한 퀴즈 생성
   * @param {number} contentId - 콘텐츠 ID
   * @param {string} contentText - 콘텐츠 텍스트
   * @param {Object} quizOptions - 퀴즈 옵션
   * @param {number} quizOptions.choiceCount - 4지선다 퀴즈 수 (기본 3개)
   * @param {number} quizOptions.oxCount - OX 퀴즈 수 (기본 2개)
   */
  async generateQuizForContent(contentId, contentText, quizOptions = {}) {
    try {
      console.log('[ContentService] Generating quiz for content', contentId);
      await this.quizService.generateQuizzesForContent(contentId, contentText, quizOptions);
    } catch (error) {
      console.error('[ContentService] Quiz generation error:', error);
      throw error;
    }
  }

  /**
   * 콘텐츠의 퀴즈 목록 조회
   */
  async getQuizzes(contentId) {
    return await this.quizService.getQuizzesByContent(contentId);
  }

  /**
   * 콘텐츠 퀴즈 재생성 (기존 퀴즈 삭제 후 새로 생성)
   * @param {number} contentId - 콘텐츠 ID
   * @param {Object} quizOptions - 퀴즈 옵션
   * @param {number} quizOptions.choiceCount - 4지선다 퀴즈 수 (기본 3개)
   * @param {number} quizOptions.oxCount - OX 퀴즈 수 (기본 2개)
   */
  async regenerateQuizzes(contentId, quizOptions = {}) {
    // 콘텐츠 존재 확인
    const content = await this.env.DB
      .prepare('SELECT id, content FROM TB_CONTENT WHERE id = ? AND status = 1')
      .bind(contentId)
      .first();

    if (!content) {
      return null;
    }

    if (!content.content || content.content.trim().length < 100) {
      throw new Error('콘텐츠 텍스트가 너무 짧아 퀴즈를 생성할 수 없습니다. (최소 100자)');
    }

    // 기존 퀴즈 삭제
    await this.quizService.deleteQuizzesByContent(contentId);

    // 새 퀴즈 생성 (동기적으로 실행하여 결과 반환)
    const quizzes = await this.quizService.generateQuizzesForContent(contentId, content.content, quizOptions);

    return {
      contentId,
      quizCount: quizzes.length,
      quizzes
    };
  }

  /**
   * 모든 콘텐츠에 대해 퀴즈 재생성 (퀴즈가 없는 콘텐츠만)
   * @param {Object} quizOptions - 퀴즈 옵션
   * @param {number} quizOptions.choiceCount - 4지선다 퀴즈 수 (기본 3개)
   * @param {number} quizOptions.oxCount - OX 퀴즈 수 (기본 2개)
   */
  async regenerateAllQuizzes(quizOptions = {}) {
    // 퀴즈가 없는 콘텐츠 조회
    const { results: contentsWithoutQuizzes } = await this.env.DB
      .prepare(`
        SELECT c.id, c.content_nm, c.content
        FROM TB_CONTENT c
        LEFT JOIN TB_QUIZ q ON c.id = q.content_id AND q.status = 1
        WHERE c.status = 1
        GROUP BY c.id
        HAVING COUNT(q.id) = 0
      `)
      .all();

    if (!contentsWithoutQuizzes || contentsWithoutQuizzes.length === 0) {
      return {
        success: true,
        total: 0,
        generated: 0,
        skipped: 0,
        errors: [],
        message: '퀴즈를 생성할 콘텐츠가 없습니다.'
      };
    }

    let generated = 0;
    let skipped = 0;
    const errors = [];

    for (const content of contentsWithoutQuizzes) {
      try {
        if (!content.content || content.content.trim().length < 100) {
          skipped++;
          console.log(`[regenerateAllQuizzes] Skipping content ${content.id} (too short)`);
          continue;
        }

        console.log(`[regenerateAllQuizzes] Generating quizzes for content ${content.id} (${content.content_nm})`);
        const quizzes = await this.quizService.generateQuizzesForContent(content.id, content.content, quizOptions);

        if (quizzes.length > 0) {
          generated++;
          console.log(`[regenerateAllQuizzes] Generated ${quizzes.length} quizzes for content ${content.id}`);
        } else {
          skipped++;
        }
      } catch (error) {
        errors.push({ id: content.id, title: content.content_nm, error: error.message });
        console.error(`[regenerateAllQuizzes] Failed for content ${content.id}:`, error.message);
      }
    }

    return {
      success: true,
      total: contentsWithoutQuizzes.length,
      generated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      message: `${generated}개 콘텐츠에 퀴즈 생성 완료${skipped > 0 ? `, ${skipped}개 스킵` : ''}${errors.length > 0 ? `, ${errors.length}개 실패` : ''}`
    };
  }

  /**
   * 콘텐츠 임베딩 생성 및 Vectorize 저장 (청크 기반)
   */
  async storeContentEmbedding(contentId, contentTitle, contentText) {
    // Vectorize가 없으면 스킵 (로컬 개발 환경)
    if (!this.env.VECTORIZE?.insert) {
      console.warn('Vectorize not available (local dev)');
      return;
    }

    try {
      // 텍스트를 청크로 분할
      const chunks = this.embeddingService.splitIntoChunks(contentText);
      console.log(`[ContentService] Splitting content ${contentId} into ${chunks.length} chunks`);

      // 각 청크를 개별 임베딩 → Vectorize에 저장
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await this.embeddingService.embed(chunk.text);

        await this.env.VECTORIZE.insert([{
          id: `content-${contentId}-chunk-${i}`,
          values: embedding,
          metadata: {
            type: 'content',
            contentId: contentId,
            contentTitle: contentTitle,
            chunkIndex: i,
            chunkCount: chunks.length,
            text: chunk.text
          }
        }]);
      }

      console.log(`Stored ${chunks.length} chunk embeddings for content ${contentId}`);
    } catch (error) {
      console.error('Embedding storage error:', error);
    }
  }

  /**
   * 콘텐츠의 모든 청크 벡터 삭제
   */
  async deleteContentChunks(contentId) {
    if (!this.env.VECTORIZE?.deleteByIds) return;

    try {
      // 기존 단일 벡터 ID도 삭제 (마이그레이션 호환)
      const ids = [`content-${contentId}`];

      // 청크 ID 삭제 (최대 100개 청크까지 지원)
      for (let i = 0; i < 100; i++) {
        ids.push(`content-${contentId}-chunk-${i}`);
      }

      await this.env.VECTORIZE.deleteByIds(ids);
      console.log(`[ContentService] Deleted chunk vectors for content ${contentId}`);
    } catch (error) {
      console.warn('Vectorize chunk delete error:', error.message);
    }
  }

  /**
   * 콘텐츠 수정 (제목 및 내용 수정)
   */
  async updateContent(id, title, newContent = null) {
    if (!title || title.trim().length === 0) {
      throw new Error('제목은 필수입니다.');
    }

    // 콘텐츠 존재 확인 (status = 1만)
    const existingContent = await this.env.DB
      .prepare('SELECT id, file_type FROM TB_CONTENT WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!existingContent) {
      return null;
    }

    const contentTitle = title.trim();

    // 내용이 변경된 경우 임베딩 재생성
    if (newContent && newContent.trim().length > 0) {
      const contentText = newContent.trim();
      const contentSize = new TextEncoder().encode(contentText).length;

      // Vectorize에서 기존 청크 벡터 삭제
      await this.deleteContentChunks(id);

      // 콘텐츠 업데이트
      await this.env.DB
        .prepare(`
          UPDATE TB_CONTENT
          SET content_nm = ?, file_size = ?, content = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(contentTitle, contentSize, contentText, id)
        .run();

      // 새 임베딩 생성 및 저장
      await this.storeContentEmbedding(id, contentTitle, contentText);
    } else {
      // 제목만 업데이트
      await this.env.DB
        .prepare('UPDATE TB_CONTENT SET content_nm = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(contentTitle, id)
        .run();
    }

    // 업데이트된 콘텐츠 반환
    return await this.getContent(id);
  }

  /**
   * 콘텐츠 삭제 (Soft Delete)
   */
  async deleteContent(id) {
    // 콘텐츠 존재 확인 (status = 1만)
    const content = await this.env.DB
      .prepare('SELECT id FROM TB_CONTENT WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!content) {
      return false;
    }

    // Vectorize에서 청크 벡터 삭제
    await this.deleteContentChunks(id);

    // 콘텐츠 soft delete (status = -1)
    await this.env.DB
      .prepare('UPDATE TB_CONTENT SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(id)
      .run();

    return true;
  }

  /**
   * 모든 콘텐츠 재임베딩
   */
  async reembedAllContents() {
    // 모든 활성 콘텐츠 조회
    const { results } = await this.env.DB
      .prepare('SELECT id, content_nm, content FROM TB_CONTENT WHERE status = 1')
      .all();

    if (!results || results.length === 0) {
      return { success: true, count: 0, message: '재임베딩할 콘텐츠가 없습니다.' };
    }

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const content of results) {
      try {
        if (content.content && content.content.trim().length > 0) {
          // 기존 벡터 삭제 후 청크 기반으로 재임베딩
          await this.deleteContentChunks(content.id);
          await this.storeContentEmbedding(content.id, content.content_nm, content.content);
          successCount++;
          console.log(`[Reembed] Content ${content.id} (${content.content_nm}) embedded successfully`);
        }
      } catch (error) {
        errorCount++;
        errors.push({ id: content.id, title: content.content_nm, error: error.message });
        console.error(`[Reembed] Content ${content.id} failed:`, error.message);
      }
    }

    return {
      success: true,
      total: results.length,
      successCount,
      errorCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `${successCount}개 콘텐츠 재임베딩 완료${errorCount > 0 ? `, ${errorCount}개 실패` : ''}`
    };
  }

  /**
   * 파일 확장자 추출
   */
  getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return ext;
  }

  /**
   * 파일에서 텍스트 추출
   */
  async extractText(file, fileType) {
    const buffer = await file.arrayBuffer();

    switch (fileType) {
      case 'txt':
      case 'md':
        return new TextDecoder('utf-8').decode(buffer);

      case 'srt':
      case 'vtt':
        return this.extractTextFromSubtitle(new TextDecoder('utf-8').decode(buffer));

      case 'pdf':
        // PDF 텍스트 추출 (간단한 방식)
        return await this.extractPdfText(buffer);

      default:
        throw new Error('지원하지 않는 파일 형식입니다.');
    }
  }

  /**
   * 추출된 텍스트 검증 (최소한의 검증만 수행)
   * 이전 동작 복원 - 빈 텍스트와 너무 짧은 텍스트만 거부
   */
  validateExtractedText(text) {
    if (!text || text.trim().length === 0) {
      console.warn('[ContentService] Validation failed: empty text');
      return false;
    }

    // 최소 길이 체크 (50자 이상)
    if (text.trim().length < 50) {
      console.warn('[ContentService] Validation failed: too short', text.trim().length);
      return false;
    }

    console.log('[ContentService] Text validation passed, length:', text.trim().length);
    return true;
  }

  /**
   * PDF에서 텍스트 추출
   * - 1차: Cloudflare Workers AI toMarkdown() (가장 안정적)
   * - 2차: unpdf 라이브러리 사용
   * - 3차: 기본 텍스트 추출 (제한적)
   */
  async extractPdfText(buffer) {
    const errors = [];
    console.log('[ContentService] Starting PDF extraction, buffer size:', buffer.byteLength);

    // 1차: Cloudflare Workers AI toMarkdown() 시도 (가장 안정적)
    if (this.env.AI?.toMarkdown) {
      try {
        console.log('[ContentService] Trying Cloudflare AI toMarkdown...');
        const result = await this.env.AI.toMarkdown({
          name: 'document.pdf',
          blob: new Blob([buffer], { type: 'application/pdf' })
        });

        console.log('[ContentService] AI toMarkdown result:', result.format, result.data?.length || 0);

        if (result.format === 'markdown' && result.data) {
          let rawText = result.data;

          // 메타데이터 블록 제거 (document.pdf\nMetadata\n...Contents\n 형식)
          // Contents 마커 찾기 (줄바꿈 개수 상관없이)
          const contentsMatch = rawText.match(/\n+Contents\n/);
          if (contentsMatch) {
            const contentsIndex = rawText.indexOf(contentsMatch[0]);
            rawText = rawText.substring(contentsIndex + contentsMatch[0].length);
          } else if (rawText.startsWith('document.pdf\nMetadata\n')) {
            // Contents 마커가 없는 경우, 메타데이터 끝까지 제거
            const metadataEndIndex = rawText.indexOf('\n\n', 100);
            if (metadataEndIndex !== -1) {
              rawText = rawText.substring(metadataEndIndex + 2);
            }
          }

          // Markdown에서 텍스트 추출 (헤더, 리스트 등 마크다운 문법 제거)
          const text = rawText
            .replace(/^#+\s*/gm, '')        // 헤더 제거
            .replace(/^\s*[-*+]\s*/gm, '')   // 리스트 마커 제거
            .replace(/\*\*|__/g, '')         // 볼드 제거
            .replace(/\*|_/g, '')            // 이탤릭 제거
            .replace(/`/g, '')               // 코드 마커 제거
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // 링크에서 텍스트만 추출
            .trim();

          if (text && this.validateExtractedText(text)) {
            console.log('[ContentService] PDF text extracted with AI toMarkdown, length:', text.length);
            return text;
          }
        }
        errors.push(`AI toMarkdown: ${result.error || '유효한 텍스트 없음'}`);
      } catch (e) {
        console.error('[ContentService] AI toMarkdown failed:', e.message);
        errors.push(`AI toMarkdown: ${e.message}`);
      }
    } else {
      console.log('[ContentService] AI toMarkdown not available');
      errors.push('AI toMarkdown: not available');
    }

    // 2차: unpdf 시도
    try {
      console.log('[ContentService] Trying unpdf...');
      const { extractText } = await import('unpdf');
      const { text } = await extractText(new Uint8Array(buffer));
      console.log('[ContentService] unpdf result length:', text?.length || 0);
      if (text && this.validateExtractedText(text)) {
        console.log('[ContentService] PDF text extracted with unpdf, length:', text.length);
        return text;
      }
      errors.push('unpdf: 유효한 텍스트 없음');
    } catch (e) {
      console.error('[ContentService] unpdf failed:', e.message);
      errors.push(`unpdf: ${e.message}`);
    }

    // 3차: 기본 추출 시도
    try {
      console.log('[ContentService] Trying basic extraction...');
      const basicText = this.extractPdfTextBasic(buffer);
      console.log('[ContentService] basic result length:', basicText?.length || 0);
      if (this.validateExtractedText(basicText)) {
        console.log('[ContentService] PDF text extracted with basic method, length:', basicText.length);
        return basicText;
      }
      errors.push('basic: 유효한 텍스트 없음');
    } catch (e) {
      console.error('[ContentService] basic extraction failed:', e.message);
      errors.push(`basic: ${e.message}`);
    }

    // 모든 방법 실패
    console.error('[ContentService] All PDF extraction methods failed:', errors.join(', '));
    throw new Error('PDF에서 텍스트를 추출할 수 없습니다. 텍스트가 포함된 PDF이거나 TXT, MD 파일을 사용해 주세요.');
  }

  /**
   * 기본 PDF 텍스트 추출 (간단한 PDF용)
   */
  extractPdfTextBasic(buffer) {
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    // 여러 방법으로 텍스트 추출 시도
    const textParts = [];

    // 방법 1: BT...ET 블록에서 텍스트 추출
    const streamRegex = /stream\s*([\s\S]*?)\s*endstream/g;
    let match;

    while ((match = streamRegex.exec(text)) !== null) {
      const streamContent = match[1];

      // Tj, TJ 연산자에서 텍스트 추출
      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(streamContent)) !== null) {
        const extracted = tjMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\');
        if (extracted.trim()) {
          textParts.push(extracted);
        }
      }

      // TJ 배열에서 텍스트 추출
      const tjArrayRegex = /\[((?:\([^)]*\)|[^\]])*)\]\s*TJ/gi;
      let tjArrayMatch;
      while ((tjArrayMatch = tjArrayRegex.exec(streamContent)) !== null) {
        const arrayContent = tjArrayMatch[1];
        const stringRegex = /\(([^)]*)\)/g;
        let strMatch;
        while ((strMatch = stringRegex.exec(arrayContent)) !== null) {
          const extracted = strMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '')
            .replace(/\\\(/g, '(')
            .replace(/\\\)/g, ')')
            .replace(/\\\\/g, '\\');
          if (extracted.trim()) {
            textParts.push(extracted);
          }
        }
      }
    }

    // 추출된 텍스트가 있으면 반환
    if (textParts.length > 0) {
      const result = textParts.join(' ').replace(/\s+/g, ' ').trim();
      if (result.length > 50) {
        return result;
      }
    }

    // 방법 2: 읽을 수 있는 텍스트 패턴 찾기
    const readableText = text
      .replace(/[^\x20-\x7E\xA0-\xFF가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 의미있는 텍스트가 있는지 확인 (최소 100자)
    if (readableText.length > 100) {
      // PDF 메타데이터 등 제거
      const cleanText = readableText
        .replace(/PDF-\d+\.\d+/g, '')
        .replace(/%[A-Za-z]+/g, '')
        .replace(/\d+\s+\d+\s+obj/g, '')
        .replace(/endobj/g, '')
        .replace(/stream|endstream/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleanText.length > 100) {
        return cleanText;
      }
    }

    throw new Error('PDF에서 텍스트를 추출할 수 없습니다.');
  }
}
