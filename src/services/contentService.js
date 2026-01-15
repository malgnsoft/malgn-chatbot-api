/**
 * Content Service
 *
 * 콘텐츠 업로드, 조회, 삭제를 처리하는 서비스입니다.
 * - 파일에서 텍스트 추출
 * - 청크 분할
 * - D1에 메타데이터 저장
 * - Vectorize에 임베딩 저장
 */
import { EmbeddingService } from './embeddingService.js';

export class ContentService {
  constructor(env) {
    this.env = env;
    this.embeddingService = new EmbeddingService(env);
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
        SELECT id, content_nm, filename, file_type, file_size, chunk_count, status, created_at
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
    // 콘텐츠 메타데이터 조회 (status = 1만)
    const content = await this.env.DB
      .prepare('SELECT id, content_nm, filename, file_type, file_size, chunk_count, status, created_at, updated_at FROM TB_CONTENT WHERE id = ? AND status = 1')
      .bind(id)
      .first();

    if (!content) {
      return null;
    }

    // 청크 조회 (status = 1만)
    const { results: chunks } = await this.env.DB
      .prepare(`
        SELECT id, content, position
        FROM TB_CHUNK
        WHERE content_id = ? AND status = 1
        ORDER BY position
      `)
      .bind(id)
      .all();

    return {
      ...content,
      chunks: chunks || []
    };
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

    // 청크 분할
    const chunks = this.embeddingService.splitIntoChunks(content);
    if (chunks.length === 0) {
      throw new Error('유효한 내용이 없습니다.');
    }

    const contentTitle = title.trim();
    const contentSize = new TextEncoder().encode(content).length;

    // D1에 콘텐츠 메타데이터 저장 (AUTOINCREMENT로 ID 자동 생성)
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, chunk_count)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, '', 'text', contentSize, chunks.length)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 청크 처리 및 임베딩 생성
    await this.processChunks(contentId, contentTitle, chunks);

    return {
      id: contentId,
      title: contentTitle,
      type: 'text',
      fileSize: contentSize,
      chunkCount: chunks.length,
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

      if (contentType.includes('text/html')) {
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

    // 청크 분할
    const chunks = this.embeddingService.splitIntoChunks(content);
    if (chunks.length === 0) {
      throw new Error('유효한 내용이 없습니다.');
    }

    const contentTitle = title.trim();
    const contentSize = new TextEncoder().encode(content).length;

    // D1에 콘텐츠 메타데이터 저장
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, chunk_count)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, url, 'link', contentSize, chunks.length)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 청크 처리 및 임베딩 생성
    await this.processChunks(contentId, contentTitle, chunks);

    return {
      id: contentId,
      title: contentTitle,
      type: 'link',
      url,
      fileSize: contentSize,
      chunkCount: chunks.length,
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
   * 파일 업로드 및 처리
   */
  async uploadFile(file, title = null) {
    // 파일 정보 추출
    const filename = file.name;
    const fileType = this.getFileType(filename);
    const fileSize = file.size;

    // 지원 형식 확인
    if (!['pdf', 'txt', 'md'].includes(fileType)) {
      throw new Error('지원하지 않는 파일 형식입니다. (지원: PDF, TXT, MD)');
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

    // 청크 분할
    const chunks = this.embeddingService.splitIntoChunks(text);
    if (chunks.length === 0) {
      throw new Error('콘텐츠에 유효한 내용이 없습니다.');
    }

    const contentTitle = title || filename.replace(/\.[^/.]+$/, '');

    // D1에 콘텐츠 메타데이터 저장
    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_CONTENT (content_nm, filename, file_type, file_size, chunk_count)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(contentTitle, filename, fileType, fileSize, chunks.length)
      .run();

    const contentId = insertResult.meta.last_row_id;

    // 청크 처리 및 임베딩 생성
    await this.processChunks(contentId, contentTitle, chunks);

    return {
      id: contentId,
      title: contentTitle,
      filename,
      fileType,
      fileSize,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 청크 처리: D1 저장 + Vectorize 임베딩 저장
   */
  async processChunks(contentId, contentTitle, chunks) {
    // 배치로 임베딩 생성
    const embeddings = await this.embeddingService.embedBatch(chunks);

    // Vectorize에 저장할 데이터 준비
    const vectors = [];

    for (let i = 0; i < chunks.length; i++) {
      // D1에 청크 저장
      const chunkResult = await this.env.DB
        .prepare(`
          INSERT INTO TB_CHUNK (content_id, content, position)
          VALUES (?, ?, ?)
        `)
        .bind(contentId, chunks[i], i)
        .run();

      const chunkId = chunkResult.meta.last_row_id;

      // Vectorize 데이터 준비 (ID는 문자열이어야 함)
      vectors.push({
        id: String(chunkId),
        values: embeddings[i],
        metadata: {
          contentId: contentId,
          contentTitle: contentTitle,
          position: i
        }
      });
    }

    // Vectorize에 배치 삽입 (로컬에서는 Vectorize가 지원되지 않음)
    if (vectors.length > 0 && this.env.VECTORIZE?.insert) {
      try {
        await this.env.VECTORIZE.insert(vectors);
      } catch (error) {
        console.warn('Vectorize insert skipped (local dev):', error.message);
      }
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

    // 내용이 변경된 경우 청크 재생성
    if (newContent && newContent.trim().length > 0) {
      const trimmedContent = newContent.trim();

      // 새 청크 분할
      const chunks = this.embeddingService.splitIntoChunks(trimmedContent);
      if (chunks.length === 0) {
        throw new Error('유효한 내용이 없습니다.');
      }

      // 기존 청크 ID 목록 조회 (Vectorize에서 삭제용)
      const { results: oldChunks } = await this.env.DB
        .prepare('SELECT id FROM TB_CHUNK WHERE content_id = ? AND status = 1')
        .bind(id)
        .all();

      // Vectorize에서 기존 벡터 삭제
      if (oldChunks && oldChunks.length > 0 && this.env.VECTORIZE?.deleteByIds) {
        try {
          const chunkIds = oldChunks.map(c => String(c.id));
          await this.env.VECTORIZE.deleteByIds(chunkIds);
        } catch (error) {
          console.warn('Vectorize delete skipped (local dev):', error.message);
        }
      }

      // 기존 청크 soft delete
      await this.env.DB
        .prepare('UPDATE TB_CHUNK SET status = -1 WHERE content_id = ?')
        .bind(id)
        .run();

      // 콘텐츠 메타데이터 업데이트
      const contentSize = new TextEncoder().encode(trimmedContent).length;
      await this.env.DB
        .prepare(`
          UPDATE TB_CONTENT
          SET content_nm = ?, file_size = ?, chunk_count = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(contentTitle, contentSize, chunks.length, id)
        .run();

      // 새 청크 처리 및 임베딩 생성
      await this.processChunks(id, contentTitle, chunks);
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

    // 청크 ID 목록 조회 (Vectorize에서 삭제용)
    const { results: chunks } = await this.env.DB
      .prepare('SELECT id FROM TB_CHUNK WHERE content_id = ? AND status = 1')
      .bind(id)
      .all();

    // Vectorize에서 벡터 삭제 (로컬에서는 Vectorize가 지원되지 않음)
    if (chunks && chunks.length > 0 && this.env.VECTORIZE?.deleteByIds) {
      try {
        const chunkIds = chunks.map(c => String(c.id));
        await this.env.VECTORIZE.deleteByIds(chunkIds);
      } catch (error) {
        console.warn('Vectorize delete skipped (local dev):', error.message);
      }
    }

    // 청크 soft delete (status = -1)
    await this.env.DB
      .prepare('UPDATE TB_CHUNK SET status = -1 WHERE content_id = ?')
      .bind(id)
      .run();

    // 콘텐츠 soft delete (status = -1)
    await this.env.DB
      .prepare('UPDATE TB_CONTENT SET status = -1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(id)
      .run();

    return true;
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

      case 'pdf':
        // PDF 텍스트 추출 (간단한 방식)
        return await this.extractPdfText(buffer);

      default:
        throw new Error('지원하지 않는 파일 형식입니다.');
    }
  }

  /**
   * PDF에서 텍스트 추출 (간단한 방식)
   * 주의: 복잡한 PDF는 텍스트 추출이 불완전할 수 있음
   */
  async extractPdfText(buffer) {
    // PDF 바이너리에서 텍스트 스트림 추출 시도
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    // PDF 텍스트 객체 패턴 찾기
    const textMatches = [];

    // BT ... ET 블록에서 텍스트 추출 시도
    const btPattern = /BT[\s\S]*?ET/g;
    const tjPattern = /\(([^)]*)\)\s*Tj/g;

    let match;
    while ((match = btPattern.exec(text)) !== null) {
      const block = match[0];
      let tjMatch;
      while ((tjMatch = tjPattern.exec(block)) !== null) {
        const extractedText = tjMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\');
        if (extractedText.trim()) {
          textMatches.push(extractedText);
        }
      }
    }

    // 추출된 텍스트가 있으면 반환
    if (textMatches.length > 0) {
      return textMatches.join(' ');
    }

    // 대체: 단순 텍스트 패턴 찾기
    const simpleText = text
      .replace(/[^\x20-\x7E\xA0-\xFF가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (simpleText.length > 100) {
      return simpleText;
    }

    // PDF 파싱 실패 시 안내 메시지
    throw new Error('PDF에서 텍스트를 추출할 수 없습니다. TXT 또는 MD 파일을 사용해 주세요.');
  }
}
