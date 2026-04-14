/**
 * Learning Service
 *
 * 학습 콘텐츠 기반으로 학습 목표, 요약, 추천 질문을 생성하고
 * 임베딩하여 Vectorize에 저장하는 서비스입니다.
 */
import { EmbeddingService } from './embeddingService.js';
import { AiLogService } from './aiLogService.js';

export class LearningService {
  constructor(env, siteId = 0) {
    this.env = env;
    this.siteId = siteId;
    this.aiLogService = new AiLogService(env, siteId);
    this.embeddingService = new EmbeddingService(env, siteId);
    // Gemma 3 12B - Google, 다국어 우수, 80K 컨텍스트
    this.model = '@cf/google/gemma-3-12b-it';
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
   * 콘텐츠가 영어 학습용인지 감지
   */
  detectEnglishLearning(content) {
    const sample = content.substring(0, 2000);
    const englishLearningPatterns = [
      /\b(vocabulary|grammar|pronunciation|listening|speaking|reading|writing)\b/i,
      /\b(verb|noun|adjective|adverb|preposition|conjunction)\b/i,
      /\b(tense|past tense|present tense|future tense)\b/i,
      /\b(sentence|clause|phrase|paragraph)\b/i,
      /영어|English|영문법|영단어|영어회화|어휘|문법|발음|듣기|말하기|읽기|쓰기/,
      /\b(lesson|unit|chapter)\b.*\d+/i,
    ];
    const hasLearningPattern = englishLearningPatterns.some(p => p.test(sample));
    const englishChars = (sample.match(/[a-zA-Z]/g) || []).length;
    const koreanChars = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
    const totalMeaningful = englishChars + koreanChars;
    const englishRatio = totalMeaningful > 0 ? englishChars / totalMeaningful : 0;
    return (englishRatio > 0.4 && koreanChars > 10) || hasLearningPattern;
  }

  /**
   * PDF 메타데이터 및 빈 페이지 마커 제거
   */
  stripPdfMetadata(text) {
    if (!text) return text;
    let cleaned = text.replace(/^document\.pdf\s*\n?Metadata\n[\s\S]*?\n\n\n\nContents\n/i, '');
    cleaned = cleaned.replace(/\n*Page \d+\n{2,}/g, '\n');
    cleaned = cleaned.replace(/^(PDFFormatVersion|IsLinearized|IsAcroFormPresent|IsXFAPresent|IsCollectionPresent|IsSignaturesPresent|CreationDate|Creator|Trapped|Producer|ModDate|Language)=.*$/gm, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    return cleaned;
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
        WHERE id IN (${placeholders}) AND status = 1 AND site_id = ?
      `)
      .bind(...contentIds, this.siteId)
      .all();

    const contentTitles = (contentResults || []).map(r => r.content_nm);
    let context = (contentResults || []).map(r => r.content).filter(c => c).join('\n\n');

    // PDF 메타데이터 제거
    context = this.stripPdfMetadata(context);

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

    // 영어 학습 콘텐츠 감지
    const isEnglishLearning = this.detectEnglishLearning(context);
    if (isEnglishLearning) {
      console.log('[LearningService] English learning content detected');
    }

    // 요약 예시 생성 (개수에 맞춤)
    const summaryExamples = Array.from({ length: summaryCount }, (_, i) => `요약 ${i + 1}`);
    const questionExamples = Array.from({ length: recommendCount }, (_, i) => ({
      question: `추천 질문 ${i + 1}`,
      answer: `질문 ${i + 1}에 대한 간결한 답변`
    }));

    // 영어 학습용 추가 지시사항
    const englishLearningInstruction = isEnglishLearning ? `
★★★ 영어 학습 콘텐츠 특별 규칙 (한국어 모국어 학습자 대상) ★★★

[학습 목표]
- "이 강의의 영어 표현/문법/어휘를 이해하고 실제 대화에서 활용할 수 있다" 형태로 작성
- 영어 원문 표현을 학습 목표에 포함하세요

[학습 요약]
- 핵심 영어 표현/문법/어휘를 한국어 설명과 함께 요약하세요
- 영어 원문은 그대로 유지하고 한국어 뜻/설명을 병기하세요
- 예: "위치 전치사 'on/in/under'를 사용하여 사물의 위치를 설명하는 방법을 학습합니다."
- 예: "'present perfect(현재완료)'는 'have/has + 과거분사' 형태로, 과거에 시작된 동작이 현재까지 영향을 미칠 때 사용합니다."

[추천 질문]
- 한국어 모국어 학습자가 영어를 배울 때 궁금해할 만한 질문을 만드세요
- 질문에 영어 표현 원문을 포함하세요
- 한영 비교, 사용법 차이, 실제 활용 맥락 중심으로 질문하세요
- 유형 예시:
  · "'make'와 'do'는 한국어로 모두 '하다'인데, 영어에서는 어떻게 구분하여 사용하나요?"
  · "이 강의에서 배운 전치사 'at/on/in'은 시간 표현에서 각각 어떤 경우에 쓰이나요?"
  · "'I used to ~'와 'I am used to ~'는 형태가 비슷한데, 의미와 사용법은 어떻게 다른가요?"

[추천 질문 답변]
- 답변에 콘텐츠의 영어 예문을 직접 인용하세요
- 한국어 번역/설명과 영어 원문을 함께 제시하세요
- 한국인이 자주 실수하는 부분을 언급하세요
` : '';

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
5. 한국어로 작성 (영어 원문 표현은 그대로 유지)
6. 수학/과학 콘텐츠에서 수식이 필요하면 LaTeX를 사용하세요. 예: \\( x^2 + y^2 = r^2 \\), \\( \\frac{a}{b} \\)
${englishLearningInstruction}
★★★ 추천 질문+답변 생성 규칙 ★★★

반드시 콘텐츠에 나오는 실제 용어를 사용하여 질문과 답변을 만드세요.

★ 질문 수준 규칙 (고급 사고력 질문) ★
- 단순 암기/정의 질문("~은/는 무엇인가요?")을 피하세요.
- 이해·적용·분석·비교 수준의 질문을 만드세요:
  · 비교형: "A와 B의 차이점은 무엇이며, 각각 어떤 상황에서 사용하나요?"
  · 적용형: "~을/를 사용하여 실제로 어떻게 표현할 수 있나요?"
  · 분석형: "~이/가 중요한 이유는 무엇이고, 어떤 맥락에서 활용되나요?"
  · 설명형: "~의 과정을 단계별로 설명해 주세요."
- 학습자가 콘텐츠를 깊이 이해했는지 확인할 수 있는 질문이어야 합니다.

★ 답변 작성 규칙 ★
- 답변은 반드시 콘텐츠 본문의 내용을 직접 인용하거나 요약하여 작성하세요.
- 답변은 4-6문장으로 충분히 자세하게 작성하세요.
- 한국어 학습 콘텐츠인 경우, 강의에 나오는 실제 예문, 표현, 단어를 답변에 포함하세요.
- 일반적인 사전적 정의가 아닌, 해당 콘텐츠에서 설명하는 구체적 내용을 답변에 담으세요.

[올바른 예시 - 한국어 학습]
- {"question": "'이거는/그거는/저거는'은 각각 어떤 상황에서 사용하며, 실제 대화에서 어떻게 활용할 수 있나요?", "answer": "이 강의에서 '이거는'은 말하는 사람 가까이에 있는 물건을 가리킬 때, '그거는'은 듣는 사람 가까이에 있는 물건을 가리킬 때, '저거는'은 말하는 사람과 듣는 사람 모두에게서 먼 물건을 가리킬 때 사용합니다. 예를 들어 교실에서 자기 책상 위의 물건을 소개할 때 '이거는 시계예요'라고 하고, 상대방 책상 위의 물건을 물을 때 '그거는 뭐예요?'라고 합니다. '저거는 달력이에요'처럼 멀리 있는 물건을 가리킬 때도 사용합니다. 이 세 표현을 구분하면 일상 대화에서 사물의 위치에 따라 자연스럽게 지시할 수 있습니다."}
${isEnglishLearning ? `
[올바른 예시 - 영어 학습]
- {"question": "'make'와 'do'는 한국어로 모두 '하다'로 번역되는데, 영어에서는 어떻게 구분하여 사용하나요?", "answer": "이 강의에서 'make'는 무언가를 창조하거나 만들어내는 행위에 사용합니다. 예를 들어 'make a cake(케이크를 만들다)', 'make a decision(결정을 내리다)', 'make a mistake(실수를 하다)'처럼 결과물이 생기는 경우에 씁니다. 반면 'do'는 행동이나 활동 자체에 초점을 맞출 때 사용합니다. 'do homework(숙제를 하다)', 'do exercise(운동을 하다)', 'do the dishes(설거지를 하다)'가 대표적입니다. 한국어에서는 모두 '하다'이지만, 영어에서는 '만들어내다=make', '수행하다=do'로 구분하면 자연스러운 표현이 됩니다."}
` : ''}
[올바른 예시 - 일반 학습]
- {"question": "광합성의 명반응과 암반응은 어떻게 연결되며, 각 단계에서 어떤 물질이 생성되나요?", "answer": "광합성은 크게 명반응과 암반응(캘빈 회로) 두 단계로 나뉘며 서로 밀접하게 연결됩니다. 명반응에서는 엽록체 틸라코이드 막에서 빛 에너지를 흡수하여 물을 분해하고, 이 과정에서 ATP와 NADPH를 생성합니다. 이 ATP와 NADPH는 암반응의 에너지원으로 사용됩니다. 암반응(캘빈 회로)에서는 스트로마에서 이산화탄소를 고정하여 포도당(C₆H₁₂O₆)을 합성합니다. 즉, 명반응이 에너지 변환을 담당하고 암반응이 탄소 고정을 담당하며, 두 단계가 협력하여 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂ 반응을 완성합니다."}

[금지 - 절대 이렇게 생성하지 마세요]
- "~란/은/는 무엇인가요?" 같은 단순 정의 질문 금지
- 콘텐츠에 없는 용어로 질문 금지
- 답변 없이 질문만 생성하는 것 금지
- "~입니다." 한 문장으로 끝나는 짧은 답변 금지

질문은 반드시 콘텐츠에서 언급된 핵심 개념을 사용하되, 깊은 이해를 요구하는 수준으로 작성하세요.`;

    const contentTitlesInfo = contentTitles.length > 0
      ? `\n\n학습 자료 제목: ${contentTitles.join(', ')}`
      : '';

    const userPrompt = `다음 학습 콘텐츠를 분석해 주세요:${contentTitlesInfo}

${context}`;

    try {
      // Workers AI 사용
      console.log('[LearningService] Calling Workers AI with model:', this.model);
      console.log('[LearningService] User prompt length:', userPrompt.length);

      const startTime = Date.now();
      const result = await this.env.AI.run(
        this.model,
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 2048,
          temperature: temperature
        },
        {
          gateway: {
            id: 'malgn-chatbot',
            skipCache: true
          }
        }
      );

      console.log('[LearningService] Workers AI result:', JSON.stringify(result));

      // AI 사용 로그
      this.aiLogService.log({
        requestType: 'learning',
        model: this.model,
        usage: result?.usage || {},
        latencyMs: Date.now() - startTime
      }).catch(() => {});

      if (!result || !result.response) {
        console.error('[LearningService] Workers AI failed: no response', result);
        const defaultSessionNm = contentTitles.length > 0
          ? contentTitles.slice(0, 2).join(', ') + (contentTitles.length > 2 ? ' 외' : '')
          : '새 대화';
        return { sessionNm: defaultSessionNm, learningGoal: null, learningSummary: null, recommendedQuestions: null };
      }

      const content = result.response || '{}';

      // JSON 파싱 (LaTeX 이스케이프 보정)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const rawJson = jsonMatch ? jsonMatch[0] : '{}';
      const fixedJson = rawJson.replace(/\\(?!["\\/bfnrtu\\])/g, '\\\\');
      const data = JSON.parse(fixedJson);

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

        // 플레이스홀더 템플릿 질문 필터링
        // "추천 질문 1", "질문 1에 대한 간결한 답변" 같은 프롬프트 예시가 그대로 나온 경우만 제거
        const hasPlaceholder = recommendedQuestions.some(q =>
          /^추천 질문 \d+$/.test(q.question.trim()) ||
          /^질문 \d+에 대한/.test(q.answer?.trim() || '')
        );
        if (hasPlaceholder) {
          console.warn('[LearningService] Placeholder text detected in questions, setting to null');
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
- 답변은 5-8문장으로 충분히 자세하게 작성하세요.
- 한국어 학습 콘텐츠인 경우, 강의에 나오는 실제 예문, 표현, 단어를 답변에 포함하세요.
- 일반적인 사전적 정의가 아닌, 해당 콘텐츠에서 설명하는 구체적 내용을 답변에 담으세요.
- 비교, 과정, 활용 등 질문의 의도에 맞게 구조적으로 답변하세요.
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
      const startTime = Date.now();
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
        { gateway: { id: 'malgn-chatbot', skipCache: true } }
      );

      // AI 사용 로그
      this.aiLogService.log({
        requestType: 'learning_answer',
        model: this.model,
        usage: result?.usage || {},
        latencyMs: Date.now() - startTime
      }).catch(() => {});

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
        WHERE id = ? AND site_id = ?
      `)
      .bind(
        sessionNm,
        learningGoal,
        learningSummary ? JSON.stringify(learningSummary) : null,
        recommendedQuestions ? JSON.stringify(recommendedQuestions) : null,
        sessionId,
        this.siteId
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
