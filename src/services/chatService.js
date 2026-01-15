/**
 * Chat Service
 *
 * RAG 기반 채팅 응답을 생성하는 서비스입니다.
 * 1. 사용자 질문을 임베딩으로 변환
 * 2. Vectorize에서 유사 문서 검색
 * 3. 검색 결과를 컨텍스트로 LLM에 전달
 * 4. 학습된 정보 기반 응답 생성
 */
import { EmbeddingService } from './embeddingService.js';

export class ChatService {
  constructor(env) {
    this.env = env;
    this.embeddingService = new EmbeddingService(env);
    this.llmModel = '@cf/meta/llama-3.1-8b-instruct';

    // 기본 AI 설정
    this.persona = '당신은 친절하고 전문적인 AI 튜터입니다.';
    this.temperature = 0.7;
    this.topP = 0.9;
    this.maxTokens = 1024;
  }

  /**
   * UUID 생성
   */
  generateId(prefix = '') {
    const uuid = crypto.randomUUID();
    return prefix ? `${prefix}-${uuid.substring(0, 8)}` : uuid;
  }

  /**
   * 세션에 연결된 콘텐츠 ID 목록 조회
   * @param {number} sessionId - 세션 ID
   * @returns {Promise<number[]>} - 콘텐츠 ID 배열 (빈 배열이면 전체 검색)
   */
  async getSessionContentIds(sessionId) {
    if (!sessionId) return [];

    try {
      const { results } = await this.env.DB
        .prepare(`
          SELECT content_id
          FROM TB_SESSION_CONTENT
          WHERE session_id = ? AND status = 1
        `)
        .bind(sessionId)
        .all();

      return (results || []).map(r => r.content_id);
    } catch (error) {
      console.error('Get session content IDs error:', error);
      return [];
    }
  }

  /**
   * 채팅 응답 생성
   * @param {string} message - 사용자 질문
   * @param {number|null} sessionId - 세션 ID (선택적)
   * @param {Object} settings - AI 설정 (선택적)
   * @returns {Promise<Object>} - 응답 객체
   */
  async chat(message, sessionId = null, settings = {}) {
    if (!message || message.trim().length === 0) {
      throw new Error('메시지가 비어있습니다.');
    }

    // AI 설정 적용
    if (settings.persona) this.persona = settings.persona;
    if (settings.temperature !== undefined) this.temperature = settings.temperature;
    if (settings.topP !== undefined) this.topP = settings.topP;
    if (settings.maxTokens !== undefined) this.maxTokens = settings.maxTokens;

    // 세션 ID 사용 (숫자형)
    const currentSessionId = sessionId;

    // 세션에 연결된 콘텐츠 ID 조회 (답변 범위 설정)
    const allowedContentIds = await this.getSessionContentIds(currentSessionId);

    // 1. 질문을 임베딩으로 변환
    const queryEmbedding = await this.embeddingService.embed(message);

    // 2. Vectorize에서 유사 문서 검색 (콘텐츠 필터링 적용)
    const searchResults = await this.searchSimilarDocuments(queryEmbedding, 5, allowedContentIds);

    // 3. 검색 결과가 없거나 유사도가 낮으면 기본 응답
    if (searchResults.length === 0) {
      return {
        response: '죄송합니다. 해당 질문에 대한 학습된 정보가 없습니다. 다른 질문을 해주시거나, 관련 문서를 업로드해 주세요.',
        sources: [],
        sessionId: currentSessionId
      };
    }

    // 4. 컨텍스트 구성
    const context = await this.buildContext(searchResults);

    // 5. LLM으로 응답 생성
    const response = await this.generateResponse(message, context);

    // 6. 참조 문서 정보 구성
    const sources = this.formatSources(searchResults);

    return {
      response,
      sources,
      sessionId: currentSessionId
    };
  }

  /**
   * Vectorize에서 유사 문서 검색
   * @param {number[]} queryEmbedding - 쿼리 임베딩 벡터
   * @param {number} topK - 검색할 최대 문서 수
   * @param {number[]} allowedContentIds - 허용된 콘텐츠 ID 배열 (빈 배열이면 전체 검색)
   */
  async searchSimilarDocuments(queryEmbedding, topK = 5, allowedContentIds = []) {
    // Vectorize가 로컬에서 지원되지 않는 경우 빈 배열 반환
    if (!this.env.VECTORIZE?.query) {
      console.warn('Vectorize not available (local dev)');
      return [];
    }

    try {
      // 콘텐츠 필터가 있으면 더 많이 검색 후 필터링
      const searchTopK = allowedContentIds.length > 0 ? topK * 3 : topK;

      const results = await this.env.VECTORIZE.query(queryEmbedding, {
        topK: searchTopK,
        returnMetadata: true,
        returnValues: false
      });

      // 유사도 임계값 필터링 (0.7 이상만)
      const threshold = 0.7;
      let filtered = (results.matches || []).filter(
        match => match.score >= threshold
      );

      // 콘텐츠 ID 필터링 (세션에 연결된 콘텐츠만)
      if (allowedContentIds.length > 0) {
        filtered = filtered.filter(
          match => allowedContentIds.includes(match.metadata?.contentId)
        );
      }

      // 최종 결과 수 제한
      return filtered.slice(0, topK);
    } catch (error) {
      console.error('Vector search error:', error);
      return [];
    }
  }

  /**
   * 검색 결과로 컨텍스트 구성
   */
  async buildContext(searchResults) {
    const contextParts = [];
    const chunkIds = searchResults.map(r => r.id);

    // D1에서 청크 내용 조회 (status = 1만)
    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      const { results } = await this.env.DB
        .prepare(`SELECT id, content FROM TB_CHUNK WHERE id IN (${placeholders}) AND status = 1`)
        .bind(...chunkIds)
        .all();

      // 검색 결과 순서대로 정렬 (Vectorize ID는 문자열, D1 ID는 정수)
      const chunkMap = new Map(results.map(r => [String(r.id), r.content]));
      for (const result of searchResults) {
        const content = chunkMap.get(result.id);
        if (content) {
          contextParts.push(content);
        }
      }
    }

    return contextParts.join('\n\n---\n\n');
  }

  /**
   * LLM으로 응답 생성
   */
  async generateResponse(question, context) {
    const systemPrompt = `${this.persona}

규칙:
1. 오직 제공된 문서 정보만을 바탕으로 답변하세요.
2. 문서에 없는 내용은 추측하지 마세요.
3. 답변은 친절하고 명확하게 해주세요.
4. 한국어로 답변하세요.
5. 문서에서 답을 찾을 수 없다면, "제공된 문서에서 해당 정보를 찾을 수 없습니다."라고 답변하세요.`;

    const userPrompt = `참고 문서:
${context}

---

질문: ${question}

위 문서를 참고하여 질문에 답변해 주세요.`;

    try {
      const result = await this.env.AI.run(this.llmModel, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        top_p: this.topP
      });

      return result.response || '응답을 생성할 수 없습니다.';
    } catch (error) {
      console.error('LLM generation error:', error);
      throw new Error('AI 응답 생성에 실패했습니다.');
    }
  }

  /**
   * 참조 문서 정보 포맷팅
   */
  formatSources(searchResults) {
    // 문서별로 그룹화 (중복 제거)
    const contentMap = new Map();

    for (const result of searchResults) {
      const contentId = result.metadata?.contentId;
      const contentTitle = result.metadata?.contentTitle;

      if (contentId && !contentMap.has(contentId)) {
        contentMap.set(contentId, {
          contentId: contentId,
          title: contentTitle || '제목 없음',
          score: result.score
        });
      }
    }

    return Array.from(contentMap.values());
  }

  /**
   * 세션 저장 (KV 사용)
   */
  async saveSession(sessionId, messages) {
    try {
      await this.env.KV.put(
        `session:${sessionId}`,
        JSON.stringify({
          messages,
          updatedAt: new Date().toISOString()
        }),
        { expirationTtl: 86400 } // 24시간
      );
    } catch (error) {
      console.error('Session save error:', error);
    }
  }

  /**
   * 세션 조회
   */
  async getSession(sessionId) {
    try {
      const data = await this.env.KV.get(`session:${sessionId}`, { type: 'json' });
      return data;
    } catch (error) {
      console.error('Session get error:', error);
      return null;
    }
  }
}
