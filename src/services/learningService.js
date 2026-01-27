/**
 * Learning Service
 *
 * 학습 콘텐츠 기반으로 학습 목표, 요약, 추천 질문을 생성하고
 * 임베딩하여 Vectorize에 저장하는 서비스입니다.
 */
import { EmbeddingService } from './embeddingService.js';

export class LearningService {
  constructor(env) {
    this.env = env;
    this.embeddingService = new EmbeddingService(env);
    this.model = 'gpt-4o-mini';
    // AI Gateway를 통해 OpenAI 호출 (지역 제한 우회)
    this.apiUrl = env.AI_GATEWAY_URL
      ? `${env.AI_GATEWAY_URL}/openai/v1/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
  }

  /**
   * 세션에 대한 학습 메타데이터 생성 및 저장
   * @param {number} sessionId - 세션 ID
   * @param {number[]} contentIds - 콘텐츠 ID 배열
   * @param {Object} settings - AI 설정 { persona, temperature, topP }
   * @returns {Promise<Object>} - 생성된 제목, 학습 목표, 요약, 추천 질문
   */
  async generateAndStoreLearningData(sessionId, contentIds, settings = {}) {
    console.log('[LearningService] Starting generateAndStoreLearningData', { sessionId, contentIds, settings });

    // 콘텐츠에서 텍스트 및 제목 추출
    const { context, contentTitles } = await this.getContentContext(contentIds);
    console.log('[LearningService] Content context:', { contextLength: context?.length || 0, contentTitles });

    if (!context || context.trim().length === 0) {
      // 컨텍스트가 없어도 콘텐츠 제목으로 세션 제목 생성
      console.log('[LearningService] No context found, using default session name');
      const defaultSessionNm = contentTitles.length > 0
        ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
        : '새 대화';
      return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null };
    }

    // 제목, 학습 목표, 요약, 추천 질문 생성 (AI 설정 적용)
    console.log('[LearningService] Generating learning data with OpenAI...');
    const learningData = await this.generateLearningData(context, contentTitles, settings);
    console.log('[LearningService] Generated learning data:', JSON.stringify(learningData, null, 2));

    // DB에 저장
    console.log('[LearningService] Saving to DB...');
    await this.saveLearningDataToDB(sessionId, learningData);
    console.log('[LearningService] Saved to DB successfully');

    // Vectorize에 임베딩 저장
    await this.storeLearningEmbeddings(sessionId, learningData, contentIds);

    return learningData;
  }

  /**
   * 콘텐츠에서 컨텍스트 텍스트 및 제목 추출
   */
  async getContentContext(contentIds) {
    const placeholders = contentIds.map(() => '?').join(',');

    // 콘텐츠 제목 및 내용 조회
    const { results: contentResults } = await this.env.DB
      .prepare(`
        SELECT content_nm, content
        FROM TB_CONTENT
        WHERE id IN (${placeholders}) AND status = 1
      `)
      .bind(...contentIds)
      .all();

    const contentTitles = (contentResults || []).map(r => r.content_nm);
    const context = (contentResults || []).map(r => r.content).filter(c => c).join('\n\n');

    return { context, contentTitles };
  }

  /**
   * 제목, 학습 목표, 요약, 추천 질문 생성
   * @param {string} context - 학습 콘텐츠 텍스트
   * @param {string[]} contentTitles - 콘텐츠 제목 배열
   * @param {Object} settings - AI 설정 { persona, temperature, topP }
   */
  async generateLearningData(context, contentTitles = [], settings = {}) {
    // AI 설정에서 페르소나 가져오기
    const persona = settings.persona || '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변합니다.';
    const temperature = settings.temperature ?? 0.7;
    const topP = settings.topP ?? 0.9;

    const systemPrompt = `${persona}

당신은 교육 전문가로서 주어진 학습 콘텐츠를 분석하여 세션 제목, 학습 목표, 요약, 추천 질문을 생성해 주세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "title": "학습 세션의 간결한 제목 (15자 이내, 핵심 주제 반영)",
  "learningGoal": "이 콘텐츠를 통해 학습자가 달성할 수 있는 학습 목표 (2-3문장)",
  "learningSummary": "콘텐츠의 핵심 내용 요약 (3-5문장)",
  "recommendedQuestions": ["추천 질문 1", "추천 질문 2", "추천 질문 3", "추천 질문 4", "추천 질문 5"]
}

규칙:
1. 제목은 학습 내용의 핵심 주제를 15자 이내로 간결하게 표현
2. 학습 목표는 구체적이고 측정 가능하게 작성
3. 요약은 핵심 개념을 포함
4. 추천 질문은 학습자의 이해를 돕는 질문 5개
5. 한국어로 작성`;

    const contentTitlesInfo = contentTitles.length > 0
      ? `\n\n학습 자료 제목: ${contentTitles.join(', ')}`
      : '';

    const userPrompt = `다음 학습 콘텐츠를 분석해 주세요:${contentTitlesInfo}

${context}`;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 1024,
          temperature: temperature,
          top_p: topP
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[LearningService] OpenAI API failed:', response.status, errorText);
        const defaultSessionNm = contentTitles.length > 0
          ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
          : '새 대화';
        return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null };
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content || '{}';

      // JSON 파싱
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const data = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');

      // 제목이 없으면 콘텐츠 제목으로 대체
      const defaultSessionNm = contentTitles.length > 0
        ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
        : '새 대화';

      return {
        sessionNm: data.title || defaultSessionNm,
        learningGoal: data.learningGoal || null,
        learningSummary: data.learningSummary || null,
        recommendedQuestions: data.recommendedQuestions || null
      };
    } catch (error) {
      console.error('Learning data generation error:', error);
      const defaultSessionNm = contentTitles.length > 0
        ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
        : '새 대화';
      return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null };
    }
  }

  /**
   * 학습 데이터 DB 저장
   */
  async saveLearningDataToDB(sessionId, learningData) {
    const { sessionNm, learningGoal, learningSummary, recommendedQuestions } = learningData;

    await this.env.DB
      .prepare(`
        UPDATE TB_SESSION
        SET session_nm = ?,
            learning_goal = ?,
            learning_summary = ?,
            recommended_questions = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        sessionNm,
        learningGoal,
        learningSummary,
        recommendedQuestions ? JSON.stringify(recommendedQuestions) : null,
        sessionId
      )
      .run();
  }

  /**
   * 학습 데이터 Vectorize에 임베딩 저장
   */
  async storeLearningEmbeddings(sessionId, learningData, contentIds) {
    const { learningGoal, learningSummary } = learningData;

    // Vectorize가 없으면 스킵
    if (!this.env.VECTORIZE?.upsert) {
      console.warn('Vectorize not available');
      return;
    }

    const vectors = [];

    // 학습 목표 임베딩
    if (learningGoal) {
      try {
        const goalEmbedding = await this.embeddingService.embed(learningGoal);
        vectors.push({
          id: `session-${sessionId}-goal`,
          values: goalEmbedding,
          metadata: {
            type: 'learning_goal',
            sessionId: sessionId,
            contentIds: contentIds,
            text: learningGoal
          }
        });
      } catch (error) {
        console.error('Goal embedding error:', error);
      }
    }

    // 학습 요약 임베딩
    if (learningSummary) {
      try {
        const summaryEmbedding = await this.embeddingService.embed(learningSummary);
        vectors.push({
          id: `session-${sessionId}-summary`,
          values: summaryEmbedding,
          metadata: {
            type: 'learning_summary',
            sessionId: sessionId,
            contentIds: contentIds,
            text: learningSummary
          }
        });
      } catch (error) {
        console.error('Summary embedding error:', error);
      }
    }

    // Vectorize에 저장
    if (vectors.length > 0) {
      try {
        await this.env.VECTORIZE.upsert(vectors);
        console.log(`Stored ${vectors.length} learning embeddings for session ${sessionId}`);
      } catch (error) {
        console.error('Vectorize upsert error:', error);
      }
    }
  }

  /**
   * 세션 삭제 시 Vectorize에서 학습 임베딩 삭제
   */
  async deleteLearningEmbeddings(sessionId) {
    if (!this.env.VECTORIZE?.deleteByIds) {
      return;
    }

    try {
      await this.env.VECTORIZE.deleteByIds([
        `session-${sessionId}-goal`,
        `session-${sessionId}-summary`
      ]);
    } catch (error) {
      console.error('Delete learning embeddings error:', error);
    }
  }
}
