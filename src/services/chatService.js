/**
 * Chat Service
 *
 * RAG 기반 채팅 응답을 생성하는 서비스입니다.
 * 1. 사용자 질문을 임베딩으로 변환
 * 2. Vectorize에서 유사 콘텐츠 검색
 * 3. 검색 결과를 컨텍스트로 LLM에 전달
 * 4. 학습된 정보 기반 응답 생성
 */
import { EmbeddingService } from './embeddingService.js';
import { QuizService } from './quizService.js';

export class ChatService {
  constructor(env) {
    this.env = env;
    this.embeddingService = new EmbeddingService(env);
    this.quizService = new QuizService(env);
    // Workers AI 사용 (지역 제한 없음)
    this.llmModel = '@cf/meta/llama-3.1-8b-instruct';

    // 기본 AI 설정
    this.persona = '당신은 친절하고 전문적인 AI 튜터입니다.';
    this.temperature = 0.3;  // 기본값 0.3 (보수적)
    this.topP = 0.3;         // 기본값 0.3 (보수적)
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
   * 세션의 이전 대화 내역 조회
   * @param {number} sessionId - 세션 ID
   * @param {number} limit - 최대 조회 개수 (기본 10개 = 5턴)
   * @returns {Promise<Array>} - 대화 내역 배열 [{role, content}, ...]
   */
  async getChatHistory(sessionId, limit = 10) {
    if (!sessionId) return [];

    try {
      const { results } = await this.env.DB
        .prepare(`
          SELECT role, content
          FROM TB_MESSAGE
          WHERE session_id = ? AND status = 1
          ORDER BY created_at DESC
          LIMIT ?
        `)
        .bind(sessionId, limit)
        .all();

      // 최신순으로 조회했으므로 역순으로 정렬하여 시간순으로 반환
      return (results || []).reverse().map(r => ({
        role: r.role,
        content: r.content
      }));
    } catch (error) {
      console.error('Get chat history error:', error);
      return [];
    }
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

    // 1. 콘텐츠 ID 조회 + 질문 임베딩을 병렬 실행
    const [allowedContentIds, queryEmbedding] = await Promise.all([
      this.getSessionContentIds(currentSessionId),
      this.embeddingService.embed(message)
    ]);

    // 2. 벡터 검색 + 퀴즈 컨텍스트 + 대화 내역을 모두 병렬 실행
    const [searchResults, quizContext, chatHistory] = await Promise.all([
      this.searchSimilarDocuments(queryEmbedding, 5, allowedContentIds, currentSessionId),
      this.getQuizContext(allowedContentIds),
      this.getChatHistory(currentSessionId, 6)
    ]);
    console.log('[ChatService] Chat history loaded:', chatHistory.length, 'messages');

    // 3. 검색 결과가 없으면 세션 학습 데이터로 fallback
    let context = '';
    if (searchResults.length === 0) {
      console.log('[ChatService] No search results, trying session learning data fallback');
      context = await this.getSessionLearningContext(currentSessionId, allowedContentIds);

      if (!context) {
        return {
          response: '죄송합니다. 해당 질문에 대한 학습된 정보가 없습니다. 다른 질문을 해주시거나, 관련 문서를 업로드해 주세요.',
          sources: [],
          sessionId: currentSessionId
        };
      }
    } else {
      context = await this.buildContext(searchResults);
    }
    if (quizContext) context += quizContext;

    // 6. LLM으로 응답 생성 (이전 대화 포함)
    const response = await this.generateResponse(message, context, chatHistory);

    // 7. 참조 문서 정보 구성
    const sources = this.formatSources(searchResults);

    // 8. 메시지를 DB에 저장 (사용자 메시지 + AI 응답)
    if (currentSessionId) {
      await this.saveMessagesToDB(currentSessionId, message, response);
    }

    return {
      response,
      sources,
      sessionId: currentSessionId
    };
  }

  /**
   * Vectorize에서 유사 콘텐츠 검색 (학습 목표/요약 포함)
   * @param {number[]} queryEmbedding - 쿼리 임베딩 벡터
   * @param {number} topK - 검색할 최대 콘텐츠 수
   * @param {number[]} allowedContentIds - 허용된 콘텐츠 ID 배열 (빈 배열이면 전체 검색)
   * @param {number|null} sessionId - 세션 ID (학습 목표/요약 검색용)
   */
  async searchSimilarDocuments(queryEmbedding, topK = 5, allowedContentIds = [], sessionId = null) {
    // Vectorize가 로컬에서 지원되지 않는 경우 빈 배열 반환
    if (!this.env.VECTORIZE?.query) {
      console.warn('Vectorize not available (local dev)');
      return [];
    }

    try {
      // 콘텐츠 필터가 있으면 더 많이 검색 후 필터링
      const searchTopK = allowedContentIds.length > 0 ? topK * 2 : topK;

      const results = await this.env.VECTORIZE.query(queryEmbedding, {
        topK: searchTopK + 5, // 학습 목표/요약 포함하여 여유분 검색
        returnMetadata: true,
        returnValues: false
      });

      console.log('[ChatService] Vectorize search results:', results.matches?.length || 0, 'matches');

      // 유사도 임계값 필터링 (0.5 이상 - 추천 질문도 매칭되도록 낮춤)
      const threshold = 0.5;
      let filtered = (results.matches || []).filter(
        match => match.score >= threshold
      );

      console.log('[ChatService] After threshold filter:', filtered.length, 'matches');

      // 학습 목표/요약과 콘텐츠 분리
      const learningResults = [];
      const contentResults = [];

      for (const match of filtered) {
        const type = match.metadata?.type;
        const metaSessionId = match.metadata?.sessionId;

        // 학습 목표/요약은 해당 세션의 것만 (타입 변환 비교)
        if (type === 'learning_goal' || type === 'learning_summary') {
          if (sessionId && Number(metaSessionId) === Number(sessionId)) {
            learningResults.push(match);
          }
        } else if (type === 'content') {
          // 콘텐츠는 ID 필터링
          const contentId = match.metadata?.contentId;
          if (allowedContentIds.length === 0 || allowedContentIds.includes(Number(contentId))) {
            contentResults.push(match);
          }
        }
      }

      console.log('[ChatService] Learning results:', learningResults.length, 'Content results:', contentResults.length);

      // 학습 목표/요약 우선 + 콘텐츠 결합
      return [...learningResults, ...contentResults.slice(0, topK)];
    } catch (error) {
      console.error('Vector search error:', error);
      return [];
    }
  }

  /**
   * 검색 결과로 컨텍스트 구성 (학습 목표/요약 + 청크 텍스트)
   */
  async buildContext(searchResults) {
    const contextParts = [];

    for (const result of searchResults) {
      const type = result.metadata?.type;

      if (type === 'learning_goal') {
        const goalText = result.metadata?.text;
        if (goalText) {
          contextParts.unshift(`[학습 목표]\n${goalText}`);
        }
      } else if (type === 'learning_summary') {
        const summaryText = result.metadata?.text;
        if (summaryText) {
          contextParts.push(`[학습 요약]\n${summaryText}`);
        }
      } else if (type === 'content') {
        // 청크 텍스트를 metadata에서 직접 사용 (DB 조회 불필요)
        const chunkText = result.metadata?.text;
        const contentTitle = result.metadata?.contentTitle || '문서';
        if (chunkText) {
          contextParts.push(`[${contentTitle}]\n${chunkText}`);
        }
      }
    }

    return contextParts.join('\n\n---\n\n');
  }

  /**
   * 세션에 연결된 콘텐츠의 퀴즈를 컨텍스트 문자열로 변환
   */
  async getQuizContext(contentIds) {
    if (!contentIds || contentIds.length === 0) return '';

    try {
      const quizzes = await this.quizService.getQuizzesByContentIds(contentIds);
      if (!quizzes || quizzes.length === 0) return '';

      const quizLines = quizzes.map(q => {
        const type = q.quizType === 'choice' ? '4지선다' : 'OX퀴즈';
        let line = `[${type}] Q: ${q.question} → 정답: ${q.answer}`;
        if (q.explanation) line += ` (해설: ${q.explanation})`;
        return line;
      });

      return `\n\n---\n\n[퀴즈 정답 정보 - 학습자 질문에 이 정보를 근거로 정확히 판단하세요]\n${quizLines.join('\n')}`;
    } catch (error) {
      console.error('Get quiz context error:', error);
      return '';
    }
  }

  /**
   * 세션 학습 데이터와 콘텐츠로 컨텍스트 구성 (Vectorize 검색 실패 시 fallback)
   */
  async getSessionLearningContext(sessionId, contentIds) {
    if (!sessionId) return null;

    try {
      const contextParts = [];

      // 세션의 학습 데이터 조회
      const session = await this.env.DB
        .prepare('SELECT learning_goal, learning_summary FROM TB_SESSION WHERE id = ? AND status = 1')
        .bind(sessionId)
        .first();

      if (session?.learning_goal) {
        contextParts.push(`[학습 목표]\n${session.learning_goal}`);
      }
      if (session?.learning_summary) {
        contextParts.push(`[학습 요약]\n${session.learning_summary}`);
      }

      // 연결된 콘텐츠 조회 (fallback이므로 앞부분 2000자만 사용)
      if (contentIds && contentIds.length > 0) {
        const placeholders = contentIds.map(() => '?').join(',');
        const { results } = await this.env.DB
          .prepare(`SELECT content_nm, content FROM TB_CONTENT WHERE id IN (${placeholders}) AND status = 1`)
          .bind(...contentIds)
          .all();

        for (const content of (results || [])) {
          if (content.content) {
            const truncated = content.content.length > 2000
              ? content.content.substring(0, 2000) + '...'
              : content.content;
            contextParts.push(`[${content.content_nm}]\n${truncated}`);
          }
        }
      }

      if (contextParts.length === 0) return null;

      console.log('[ChatService] Using session learning context fallback, parts:', contextParts.length);
      return contextParts.join('\n\n---\n\n');
    } catch (error) {
      console.error('Get session learning context error:', error);
      return null;
    }
  }

  /**
   * LLM으로 응답 생성 (Workers AI 사용)
   * @param {string} question - 현재 질문
   * @param {string} context - RAG 컨텍스트
   * @param {Array} chatHistory - 이전 대화 내역 [{role, content}, ...]
   */
  async generateResponse(question, context, chatHistory = []) {
    const systemPrompt = `${this.persona}

규칙:
1. 오직 제공된 문서 정보만을 바탕으로 답변하세요.
2. 문서에 없는 내용은 추측하지 마세요.
3. 답변은 친절하고 명확하게 해주세요.
4. 한국어로 답변하세요.
5. 문서에서 답을 찾을 수 없다면, "제공된 문서에서 해당 정보를 찾을 수 없습니다."라고 답변하세요.
6. 이전 대화 내용을 참고하여 맥락에 맞는 답변을 해주세요.
7. 학습자가 틀린 내용을 말하면 반드시 정정해 주세요. 절대로 틀린 내용에 동조하지 마세요. 문서를 근거로 올바른 정보를 알려주세요.
8. "~이 맞아?", "~이 맞나요?" 같은 확인 질문에는 문서 내용과 대조하여 맞는지 틀린지 정확히 판단하세요.

참고 문서:
${context}`;

    // 메시지 배열 구성: system → 이전 대화 → 현재 질문
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // 이전 대화 내역 추가
    if (chatHistory && chatHistory.length > 0) {
      for (const msg of chatHistory) {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // 현재 질문 추가
    messages.push({ role: 'user', content: question });

    try {
      // Workers AI 사용
      const result = await this.env.AI.run(this.llmModel, {
        messages,
        max_tokens: this.maxTokens,
        temperature: this.temperature
      });

      if (result && result.response) {
        return result.response;
      }

      return '응답을 생성할 수 없습니다.';
    } catch (error) {
      console.error('LLM generation error:', error);
      throw new Error('AI 응답 생성에 실패했습니다.');
    }
  }

  /**
   * 참조 문서 정보 포맷팅
   */
  formatSources(searchResults) {
    // 콘텐츠별로 그룹화 (중복 제거)
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
   * 메시지를 DB에 저장 (사용자 메시지 + AI 응답)
   */
  async saveMessagesToDB(sessionId, userMessage, assistantResponse) {
    try {
      // D1 batch: 단일 라운드트립으로 3개 쿼리 실행
      await this.env.DB.batch([
        this.env.DB
          .prepare('INSERT INTO TB_MESSAGE (session_id, role, content) VALUES (?, ?, ?)')
          .bind(sessionId, 'user', userMessage),
        this.env.DB
          .prepare('INSERT INTO TB_MESSAGE (session_id, role, content) VALUES (?, ?, ?)')
          .bind(sessionId, 'assistant', assistantResponse),
        this.env.DB
          .prepare('UPDATE TB_SESSION SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(sessionId)
      ]);

      console.log(`[ChatService] Messages saved to DB for session ${sessionId}`);
    } catch (error) {
      console.error('Save messages to DB error:', error);
      // 메시지 저장 실패해도 응답은 반환 (에러를 throw하지 않음)
    }
  }

  /**
   * 스트리밍 채팅 응답 생성
   * RAG 처리 후 LLM 스트리밍 응답을 반환합니다.
   * @param {string} message - 사용자 질문
   * @param {number|null} sessionId - 세션 ID
   * @param {Object} settings - AI 설정
   * @returns {Promise<Object>} - { messages, sources, sessionId, searchResults }
   */
  async prepareChatContext(message, sessionId = null, settings = {}) {
    if (!message || message.trim().length === 0) {
      throw new Error('메시지가 비어있습니다.');
    }

    // AI 설정 적용
    if (settings.persona) this.persona = settings.persona;
    if (settings.temperature !== undefined) this.temperature = settings.temperature;
    if (settings.topP !== undefined) this.topP = settings.topP;
    if (settings.maxTokens !== undefined) this.maxTokens = settings.maxTokens;

    const currentSessionId = sessionId;
    const t0 = Date.now();

    // 병렬 처리: 콘텐츠 ID 조회 + 질문 임베딩 동시 실행
    const [allowedContentIds, queryEmbedding] = await Promise.all([
      this.getSessionContentIds(currentSessionId),
      this.embeddingService.embed(message)
    ]);
    const t1 = Date.now();
    console.log(`[PERF] 1단계 콘텐츠ID+임베딩: ${t1 - t0}ms`);

    // 벡터 검색 + 퀴즈 컨텍스트 + 대화 내역을 모두 병렬 실행
    const [searchResults, quizContext, chatHistory] = await Promise.all([
      this.searchSimilarDocuments(queryEmbedding, 5, allowedContentIds, currentSessionId),
      this.getQuizContext(allowedContentIds),
      this.getChatHistory(currentSessionId, 6)
    ]);
    const t2 = Date.now();
    console.log(`[PERF] 2단계 벡터검색+퀴즈+대화내역: ${t2 - t1}ms`);

    // 컨텍스트 구성
    let context = '';
    if (searchResults.length === 0) {
      console.log('[ChatService] No search results, trying session learning data fallback');
      context = await this.getSessionLearningContext(currentSessionId, allowedContentIds);

      if (!context) {
        return { noContext: true, sessionId: currentSessionId, sources: [] };
      }
    } else {
      context = await this.buildContext(searchResults);
    }
    if (quizContext) context += quizContext;
    const t3 = Date.now();
    console.log(`[PERF] 3단계 컨텍스트 구성: ${t3 - t2}ms`);
    console.log(`[PERF] prepareChatContext 총: ${t3 - t0}ms`);

    // LLM 메시지 배열 구성
    const systemPrompt = `${this.persona}

규칙:
1. 오직 제공된 문서 정보만을 바탕으로 답변하세요.
2. 문서에 없는 내용은 추측하지 마세요.
3. 답변은 친절하고 명확하게 해주세요.
4. 한국어로 답변하세요.
5. 문서에서 답을 찾을 수 없다면, "제공된 문서에서 해당 정보를 찾을 수 없습니다."라고 답변하세요.
6. 이전 대화 내용을 참고하여 맥락에 맞는 답변을 해주세요.
7. 학습자가 틀린 내용을 말하면 반드시 정정해 주세요. 절대로 틀린 내용에 동조하지 마세요. 문서를 근거로 올바른 정보를 알려주세요.
8. "~이 맞아?", "~이 맞나요?" 같은 확인 질문에는 문서 내용과 대조하여 맞는지 틀린지 정확히 판단하세요.

참고 문서:
${context}`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (chatHistory && chatHistory.length > 0) {
      for (const msg of chatHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: message });

    const sources = this.formatSources(searchResults);

    return { messages, sources, sessionId: currentSessionId, noContext: false };
  }

  /**
   * LLM 스트리밍 응답 생성 (Workers AI stream: true)
   * @param {Array} messages - LLM 메시지 배열
   * @returns {ReadableStream} - SSE 형식의 스트림
   */
  async generateResponseStream(messages) {
    const result = await this.env.AI.run(this.llmModel, {
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true
    });
    return result;
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
