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
    const questionExamples = Array.from({ length: recommendCount }, (_, i) => ({
      question: `추천 질문 ${i + 1}`,
      answer: `질문 ${i + 1}에 대한 간결한 답변`
    }));

    const systemPrompt = `${persona}

당신은 교육 전문가로서 주어진 학습 콘텐츠를 분석하여 세션 제목, 학습 목표, 요약, 추천 질문과 답변을 생성해 주세요.

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
- recommendedQuestions의 각 항목은 반드시 {"question": "...", "answer": "..."} 형태

규칙:
1. 제목은 학습 내용의 핵심 주제를 15자 이내로 간결하게 표현
2. 학습 목표는 구체적이고 측정 가능하게 1-2문장으로 작성
3. 요약은 핵심 내용을 정확히 ${summaryCount}개의 단문으로 작성 (배열 형태)
4. 추천 질문은 정확히 ${recommendCount}개만 생성
5. 한국어로 작성

★★★ 추천 질문+답변 생성 규칙 ★★★

반드시 콘텐츠에 나오는 실제 용어를 사용하여 질문과 답변을 만드세요.

★ 답변 작성 규칙 ★
- 답변은 반드시 콘텐츠 본문의 내용을 직접 인용하거나 요약하여 작성하세요.
- 답변은 4-6문장으로 충분히 자세하게 작성하세요.
- 한국어 학습 콘텐츠인 경우, 강의에 나오는 실제 예문, 표현, 단어를 답변에 포함하세요.
- 일반적인 사전적 정의가 아닌, 해당 콘텐츠에서 설명하는 구체적 내용을 답변에 담으세요.

[올바른 예시 - 한국어 학습]
- {"question": "위치를 나타내는 표현에는 어떤 것이 있나요?", "answer": "이 강의에서는 위치를 나타내는 다양한 표현을 배웁니다. '위(on/above)', '아래(under/below)', '앞(in front of)', '뒤(behind)', '옆(beside)', '안(inside)', '밖(outside)' 등이 있습니다. 예를 들어 '책상 위에 책이 있어요', '의자 아래에 고양이가 있어요'처럼 사용합니다. 이러한 위치 표현은 '-에' 조사와 함께 사용되어 사물이나 사람의 위치를 설명할 때 쓰입니다."}

[올바른 예시 - 일반 학습]
- {"question": "광합성 과정은 어떻게 진행되나요?", "answer": "광합성은 식물이 빛 에너지를 화학 에너지로 변환하는 과정입니다. 먼저 명반응 단계에서 엽록체의 틸라코이드 막에서 빛을 흡수하여 물을 분해하고, ATP와 NADPH를 생성합니다. 이어서 캘빈 회로(암반응)에서 이산화탄소를 고정하여 포도당을 합성합니다. 이 과정은 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂로 요약됩니다."}

[금지 - 절대 이렇게 생성하지 마세요]
- 물결표(~) 사용 금지
- "~란/은/는" 같은 템플릿 텍스트 금지
- 콘텐츠에 없는 용어로 질문 금지
- 답변 없이 질문만 생성하는 것 금지
- "~입니다." 한 문장으로 끝나는 짧은 답변 금지

질문은 반드시 콘텐츠에서 언급된 핵심 개념을 사용하세요.`;

    const contentTitlesInfo = contentTitles.length > 0
      ? `\n\n학습 자료 제목: ${contentTitles.join(', ')}`
      : '';

    const userPrompt = `다음 학습 콘텐츠를 분석해 주세요:${contentTitlesInfo}

${context}`;

    try {
      // Workers AI 사용
      console.log('[LearningService] Calling Workers AI with model:', this.model);
      console.log('[LearningService] User prompt length:', userPrompt.length);

      const result = await this.env.AI.run(
        this.model,
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 1024,
          temperature: temperature
        },
        {
          gateway: {
            id: 'malgn-chatbot',
            skipCache: false
          }
        }
      );

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

      // 템플릿 텍스트 필터링 및 Q&A 형식 정규화
      if (Array.isArray(recommendedQuestions)) {
        // 기존 문자열 배열 → Q&A 객체 배열로 변환 (하위 호환)
        recommendedQuestions = recommendedQuestions.map(q => {
          if (typeof q === 'string') return { question: q, answer: '' };
          if (q && typeof q === 'object' && q.question) return q;
          return null;
        }).filter(q => q !== null);

        // 물결표(~)가 포함된 템플릿 질문 필터링
        const hasTemplatePlaceholder = recommendedQuestions.some(q => q.question.includes('~'));
        // "추천 질문 1" 같은 플레이스홀더 필터링
        const hasPlaceholder = recommendedQuestions.some(q =>
          /^추천 질문 \d+$/.test(q.question.trim())
        );
        if (hasTemplatePlaceholder || hasPlaceholder) {
          console.warn('[LearningService] Template/placeholder text detected in questions, setting to null');
          recommendedQuestions = null;
        }

        // 답변이 없는 질문이 있으면 2차 LLM 호출로 답변 생성
        if (recommendedQuestions && recommendedQuestions.some(q => !q.answer)) {
          console.log('[LearningService] Missing answers detected, generating answers via 2nd LLM call...');
          try {
            recommendedQuestions = await this.generateAnswersForQuestions(recommendedQuestions, context);
          } catch (err) {
            console.error('[LearningService] Answer generation failed:', err.message);
          }
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
   * 답변이 없는 추천 질문에 대해 답변을 생성하는 2차 LLM 호출
   * @param {Array} questions - [{question, answer}] 배열
   * @param {string} context - 학습 콘텐츠 텍스트
   * @returns {Promise<Array>} - 답변이 채워진 Q&A 배열
   */
  async generateAnswersForQuestions(questions, context) {
    const questionsToAnswer = questions.filter(q => !q.answer);
    if (questionsToAnswer.length === 0) return questions;

    // 컨텍스트 길이 제한 (답변 생성용은 더 짧게)
    const truncatedContext = context.length > 16000 ? context.substring(0, 16000) : context;

    const systemPrompt = `당신은 교육 전문가입니다. 주어진 학습 콘텐츠를 기반으로 각 질문에 대한 답변을 생성해 주세요.

규칙:
- 답변은 반드시 콘텐츠 본문의 내용을 직접 인용하거나 요약하여 작성하세요.
- 답변은 4-6문장으로 충분히 자세하게 작성하세요.
- 한국어 학습 콘텐츠인 경우, 강의에 나오는 실제 예문, 표현, 단어를 답변에 포함하세요.
- 일반적인 사전적 정의가 아닌, 해당 콘텐츠에서 설명하는 구체적 내용을 답변에 담으세요.
- 반드시 JSON 배열만 출력하세요.

출력 형식:
[
  {"question": "질문1", "answer": "상세한 답변1"},
  {"question": "질문2", "answer": "상세한 답변2"}
]`;

    const questionList = questionsToAnswer.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
    const userPrompt = `다음 학습 콘텐츠를 참고하여 각 질문에 답변해 주세요.

질문 목록:
${questionList}

학습 콘텐츠:
${truncatedContext}`;

    try {
      const result = await this.env.AI.run(
        this.model,
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 2048,
          temperature: 0.2
        },
        { gateway: { id: 'malgn-chatbot', skipCache: false } }
      );

      if (!result?.response) return questions;

      const jsonMatch = result.response.match(/\[[\s\S]*\]/);
      const answers = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');

      // 답변 매핑
      const answerMap = {};
      for (const a of answers) {
        if (a.question && a.answer) {
          answerMap[a.question] = a.answer;
        }
      }

      // 원래 질문 배열에 답변 채워넣기
      return questions.map(q => {
        if (q.answer) return q;
        // 정확 매칭 또는 부분 매칭
        const exactMatch = answerMap[q.question];
        if (exactMatch) return { ...q, answer: exactMatch };
        // 인덱스 기반 폴백
        const idx = questionsToAnswer.findIndex(qt => qt.question === q.question);
        if (idx >= 0 && answers[idx]?.answer) {
          return { ...q, answer: answers[idx].answer };
        }
        return q;
      });
    } catch (error) {
      console.error('[LearningService] generateAnswersForQuestions error:', error.message);
      return questions;
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
