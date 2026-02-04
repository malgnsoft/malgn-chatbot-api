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
    // Workers AI 사용 - 70B 모델로 더 큰 컨텍스트 지원
    this.model = '@cf/meta/llama-3.1-70b-instruct';
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
    console.log('[LearningService] Generating learning data with Workers AI...');
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
   * Workers AI 토큰 제한으로 인해 컨텍스트 길이를 제한합니다.
   */
  async getContentContext(contentIds) {
    const placeholders = contentIds.map(() => '?').join(',');
    // Workers AI (Llama 3.1 70B) - 더 큰 컨텍스트 지원
    // 약 16000 토큰 = 약 32000~48000자 (한국어 기준)
    const MAX_CONTEXT_LENGTH = 32000;

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
    let context = (contentResults || []).map(r => r.content).filter(c => c).join('\n\n');

    // 컨텍스트 길이 제한
    if (context.length > MAX_CONTEXT_LENGTH) {
      console.log(`[LearningService] Context truncated from ${context.length} to ${MAX_CONTEXT_LENGTH} characters`);
      context = context.substring(0, MAX_CONTEXT_LENGTH) + '\n\n[내용이 길어 일부만 표시됨...]';
    }

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
    // 추천 질문 생성은 temperature 0.2로 고정 (매우 보수적)
    const temperature = 0.2;
    const topP = settings.topP ?? 0.3;
    // 요약 개수와 추천 질문 개수 설정
    const summaryCount = settings.summaryCount ?? 3;
    const recommendCount = settings.recommendCount ?? 3;

    // 요약 예시 생성 (개수에 맞춤)
    const summaryExamples = Array.from({ length: summaryCount }, (_, i) => `요약 ${i + 1}`);
    const questionExamples = Array.from({ length: recommendCount }, (_, i) => `추천 질문 ${i + 1}`);

    const systemPrompt = `${persona}

당신은 교육 전문가로서 주어진 학습 콘텐츠를 분석하여 세션 제목, 학습 목표, 요약, 추천 질문을 생성해 주세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "title": "학습 세션의 간결한 제목 (15자 이내, 핵심 주제 반영)",
  "learningGoal": "이 콘텐츠를 통해 학습자가 달성할 수 있는 학습 목표 (1-2문장)",
  "learningSummary": ${JSON.stringify(summaryExamples)},
  "recommendedQuestions": ${JSON.stringify(questionExamples)}
}

★★★ 매우 중요 - 개수 제한 ★★★
- learningSummary: 정확히 ${summaryCount}개만 생성 (더 많거나 적으면 안됨)
- recommendedQuestions: 정확히 ${recommendCount}개만 생성 (더 많거나 적으면 안됨)

규칙:
1. 제목은 학습 내용의 핵심 주제를 15자 이내로 간결하게 표현
2. 학습 목표는 구체적이고 측정 가능하게 1-2문장으로 작성
3. 요약은 핵심 내용을 정확히 ${summaryCount}개의 단문으로 작성 (배열 형태)
4. 추천 질문은 정확히 ${recommendCount}개만 생성
5. 한국어로 작성

★★★ 추천 질문 생성 규칙 ★★★

반드시 콘텐츠에 나오는 실제 용어를 사용하여 질문을 만드세요.

[올바른 질문 예시]
- "단어란 무엇인가요?"
- "구의 특징은 무엇인가요?"
- "명사에는 어떤 것들이 있나요?"
- "동사란 무엇인가요?"
- "형용사의 역할은 무엇인가요?"

[금지 - 절대 이렇게 생성하지 마세요]
- 물결표(~) 사용 금지
- "~란/은/는" 같은 템플릿 텍스트 금지
- 콘텐츠에 없는 용어로 질문 금지

질문은 반드시 콘텐츠에서 언급된 핵심 개념(예: 단어, 구, 절, 명사, 동사 등)을 사용하세요.`;

    const contentTitlesInfo = contentTitles.length > 0
      ? `\n\n학습 자료 제목: ${contentTitles.join(', ')}`
      : '';

    const userPrompt = `다음 학습 콘텐츠를 분석해 주세요:${contentTitlesInfo}

${context}`;

    try {
      // Workers AI 사용
      console.log('[LearningService] Calling Workers AI with model:', this.model);
      console.log('[LearningService] User prompt length:', userPrompt.length);

      const result = await this.env.AI.run(this.model, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 1024,
        temperature: temperature
      });

      console.log('[LearningService] Workers AI result:', JSON.stringify(result));

      if (!result || !result.response) {
        console.error('[LearningService] Workers AI failed: no response', result);
        const defaultSessionNm = contentTitles.length > 0
          ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
          : '새 대화';
        return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null };
      }

      const content = result.response || '{}';

      // JSON 파싱
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const data = JSON.parse(jsonMatch ? jsonMatch[0] : '{}');

      // 제목이 없으면 콘텐츠 제목으로 대체
      const defaultSessionNm = contentTitles.length > 0
        ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
        : '새 대화';

      // 배열 길이 검증 및 자르기 (설정된 개수만큼만 유지)
      let learningSummary = data.learningSummary || null;
      let recommendedQuestions = data.recommendedQuestions || null;

      if (Array.isArray(learningSummary) && learningSummary.length > summaryCount) {
        console.log(`[LearningService] Truncating summary from ${learningSummary.length} to ${summaryCount}`);
        learningSummary = learningSummary.slice(0, summaryCount);
      }

      if (Array.isArray(recommendedQuestions) && recommendedQuestions.length > recommendCount) {
        console.log(`[LearningService] Truncating questions from ${recommendedQuestions.length} to ${recommendCount}`);
        recommendedQuestions = recommendedQuestions.slice(0, recommendCount);
      }

      // 템플릿 텍스트 필터링
      if (Array.isArray(recommendedQuestions)) {
        // 물결표(~)가 포함된 템플릿 질문 필터링
        const hasTemplatePlaceholder = recommendedQuestions.some(q => q.includes('~'));
        // "추천 질문 1" 같은 플레이스홀더 필터링
        const hasPlaceholder = recommendedQuestions.some(q =>
          /^추천 질문 \d+$/.test(q.trim())
        );
        if (hasTemplatePlaceholder || hasPlaceholder) {
          console.warn('[LearningService] Template/placeholder text detected in questions, setting to null');
          recommendedQuestions = null;
        }
      }

      if (Array.isArray(learningSummary)) {
        // "요약 1", "요약 2" 같은 플레이스홀더만 필터링
        const hasPlaceholder = learningSummary.some(s =>
          /^요약 \d+$/.test(s.trim())
        );
        if (hasPlaceholder) {
          console.warn('[LearningService] Placeholder text detected in summary, setting to null');
          learningSummary = null;
        }
      }

      return {
        sessionNm: data.title || defaultSessionNm,
        learningGoal: data.learningGoal || null,
        learningSummary: learningSummary,
        recommendedQuestions: recommendedQuestions
      };
    } catch (error) {
      console.error('[LearningService] Learning data generation error:', error.message, error.stack);
      const defaultSessionNm = contentTitles.length > 0
        ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
        : '새 대화';
      return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null, error: error.message };
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
        learningSummary ? JSON.stringify(learningSummary) : null,
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
