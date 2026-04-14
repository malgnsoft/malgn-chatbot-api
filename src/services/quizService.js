/**
 * Quiz Service
 *
 * 학습 콘텐츠를 기반으로 퀴즈를 생성하는 서비스입니다.
 * Cloudflare Workers AI를 사용하여 4지선다와 OX퀴즈를 생성합니다.
 *
 * 퀴즈는 콘텐츠 업로드 시 생성되어 TB_QUIZ에 content_id로 저장됩니다.
 * 세션 생성 시에는 연결된 콘텐츠의 퀴즈를 조회하여 사용합니다.
 */
import { AiLogService } from './aiLogService.js';

export class QuizService {
  constructor(env, siteId = 0) {
    this.env = env;
    this.siteId = siteId;
    this.aiLogService = new AiLogService(env, siteId);
    // Gemma 3 12B - Google, 다국어 우수
    this.model = '@cf/google/gemma-3-12b-it';
  }

  /**
   * 콘텐츠 기반으로 퀴즈 생성 (세션 생성 시 호출)
   * @param {number} contentId - 콘텐츠 ID
   * @param {string} content - 콘텐츠 텍스트
   * @param {Object|number} quizOptions - 퀴즈 옵션 또는 총 퀴즈 수 (하위 호환)
   * @param {number} quizOptions.choiceCount - 4지선다 퀴즈 수 (기본 3개)
   * @param {number} quizOptions.oxCount - OX 퀴즈 수 (기본 2개)
   * @param {number} sessionId - 세션 ID (퀴즈를 세션에 귀속)
   * @returns {Promise<Object[]>} - 생성된 퀴즈 배열
   */
  async generateQuizzesForContent(contentId, content, quizOptions = {}, sessionId = null) {
    if (!content || content.trim().length === 0) {
      console.log('[QuizService] No content provided, skipping quiz generation');
      return [];
    }

    // PDF 메타데이터 제거
    content = this.stripPdfMetadata(content);

    // 콘텐츠가 너무 짧으면 스킵 (메타데이터 제거 후)
    if (content.trim().length < 100) {
      console.log('[QuizService] Content too short for quiz generation (after metadata removal)');
      return [];
    }

    // 하위 호환: 숫자로 전달되면 기존 방식으로 처리
    let choiceCount, oxCount;
    if (typeof quizOptions === 'number') {
      const totalCount = quizOptions;
      choiceCount = Math.ceil(totalCount / 2);
      oxCount = totalCount - choiceCount;
    } else {
      choiceCount = quizOptions.choiceCount ?? 3;
      oxCount = quizOptions.oxCount ?? 2;
    }
    const difficulty = (typeof quizOptions === 'object' && quizOptions.difficulty) || 'normal';

    console.log('[QuizService] Generating quizzes for content', contentId, 'choice:', choiceCount, 'ox:', oxCount, 'difficulty:', difficulty);

    const quizzes = [];

    // 4지선다 퀴즈 생성 (요청 수만큼만 사용)
    if (choiceCount > 0) {
      const choiceQuizzes = await this.generateChoiceQuizzes(content, choiceCount, difficulty);
      quizzes.push(...choiceQuizzes.slice(0, choiceCount));
    }

    // OX 퀴즈 생성 (요청 수만큼만 사용)
    if (oxCount > 0) {
      const oxQuizzes = await this.generateOXQuizzes(content, oxCount, difficulty);
      quizzes.push(...oxQuizzes.slice(0, oxCount));
    }

    // DB에 저장
    if (quizzes.length > 0) {
      await this.saveQuizzesForContent(contentId, quizzes, sessionId);
      console.log('[QuizService] Saved', quizzes.length, 'quizzes for content', contentId, 'session', sessionId);
    }

    return quizzes;
  }

  /**
   * 콘텐츠에서 컨텍스트 텍스트 추출 (여러 콘텐츠)
   */
  async getContentContext(contentIds) {
    const placeholders = contentIds.map(() => '?').join(',');

    const { results } = await this.env.DB
      .prepare(`
        SELECT content
        FROM TB_CONTENT
        WHERE id IN (${placeholders}) AND status = 1 AND site_id = ?
      `)
      .bind(...contentIds, this.siteId)
      .all();

    return (results || []).map(r => r.content).filter(c => c).join('\n\n');
  }

  /**
   * PDF 메타데이터 및 빈 페이지 마커 제거
   */
  stripPdfMetadata(text) {
    if (!text) return text;

    // document.pdf\nMetadata\n... 부터 Contents 시작 전까지 제거
    let cleaned = text.replace(/^document\.pdf\s*\n?Metadata\n[\s\S]*?\n\n\n\nContents\n/i, '');

    // 빈 페이지 마커 제거 (Page N 다음에 내용 없이 바로 다음 Page)
    cleaned = cleaned.replace(/\n*Page \d+\n{2,}/g, '\n');

    // PDF 메타데이터 키=값 패턴 제거
    cleaned = cleaned.replace(/^(PDFFormatVersion|IsLinearized|IsAcroFormPresent|IsXFAPresent|IsCollectionPresent|IsSignaturesPresent|CreationDate|Creator|Trapped|Producer|ModDate|Language)=.*$/gm, '');

    // 연속 빈 줄 정리
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    if (cleaned.length < text.length * 0.5) {
      console.log(`[QuizService] Stripped PDF metadata: ${text.length} → ${cleaned.length} chars`);
    }

    return cleaned;
  }

  /**
   * 난이도별 프롬프트 지시 생성
   */
  getDifficultyInstruction(difficulty) {
    switch (difficulty) {
      case 'easy':
        return `★★★ 난이도: 쉬움 ★★★
- 콘텐츠에 직접 나오는 기본 사실과 용어를 묻는 문제를 출제하세요.
- 본문을 읽으면 바로 답을 찾을 수 있는 수준이어야 합니다.
- 단순 암기/이해 확인 문제 위주로 출제하세요.
- 오답 선택지는 명확히 틀린 것으로 만들어 혼동을 최소화하세요.`;
      case 'hard':
        return `★★★ 난이도: 어려움 ★★★
- 콘텐츠의 내용을 깊이 이해해야 풀 수 있는 응용/분석 문제를 출제하세요.
- 여러 개념을 비교하거나, 상황에 적용하는 문제를 만드세요.
- 오답 선택지를 그럴듯하게 만들어 깊은 이해 없이는 구분하기 어렵게 하세요.
- "다음 중 올바르지 않은 것은?", "A와 B의 차이점은?", "~한 상황에서 적절한 것은?" 같은 고차 사고력 질문을 사용하세요.`;
      default: // normal
        return `★★★ 난이도: 보통 ★★★
- 콘텐츠의 핵심 개념을 이해했는지 확인하는 문제를 출제하세요.
- 단순 암기가 아닌, 개념의 의미와 특징을 묻는 수준이어야 합니다.
- 오답 선택지는 적당히 그럴듯하게 만들되, 본문을 이해하면 구분 가능한 수준으로 하세요.`;
    }
  }

  /**
   * 콘텐츠가 영어 학습용인지 감지
   * 영어 텍스트 비율이 높고 한국어가 섞여있거나, 어학 관련 패턴이 있으면 영어 학습으로 판단
   */
  detectEnglishLearning(content) {
    const sample = content.substring(0, 2000);

    // 한국어 학습 콘텐츠 제외 (외국인 대상 한국어 강의)
    const koreanLearningPatterns = [
      /한국어|한국 사람|한국인|안녕하세요|감사합니다/,
      /Korean|한글|받침|모음|자음|존댓말|반말/,
      /이에요|이예요|입니다|습니다/,
    ];
    if (koreanLearningPatterns.some(p => p.test(sample))) return false;

    // 영어 학습 관련 키워드 패턴
    const englishLearningPatterns = [
      /\b(vocabulary|grammar|pronunciation|listening|speaking|reading|writing)\b/i,
      /\b(verb|noun|adjective|adverb|preposition|conjunction)\b/i,
      /\b(tense|past tense|present tense|future tense)\b/i,
      /\b(sentence|clause|phrase|paragraph)\b/i,
      /영어|English|영문법|영단어|영어회화/,
      /\b(lesson|unit|chapter)\b.*\d+/i,
    ];
    const hasLearningPattern = englishLearningPatterns.some(p => p.test(sample));

    // 영어 문자 비율 계산
    const englishChars = (sample.match(/[a-zA-Z]/g) || []).length;
    const koreanChars = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
    const totalMeaningful = englishChars + koreanChars;
    const englishRatio = totalMeaningful > 0 ? englishChars / totalMeaningful : 0;

    // 영어 비율이 40% 이상이고 한국어도 있으면 영어 학습, 또는 영어 학습 패턴 발견
    return (englishRatio > 0.4 && koreanChars > 10) || hasLearningPattern;
  }

  /**
   * 수학/과학 콘텐츠 감지
   */
  detectMathScience(content) {
    const sample = content.substring(0, 2000);
    const mathPatterns = [
      /방정식|연립|미지수|함수|그래프/,
      /수학|산수|계산|풀이/,
      /\d+\s*[+\-×÷=]\s*\d+/,
      /[xyz]\s*[+\-=]\s*\d+/i,
      /분수|소수|백분율|비율/,
      /삼각형|사각형|원|도형|넓이|부피/,
      /속력|거리|시간|속도/,
      /물리|화학|과학|에너지|힘|질량/,
    ];
    return mathPatterns.some(p => p.test(sample));
  }

  /**
   * 수학/과학 퀴즈 추가 지시사항
   */
  getMathScienceInstruction() {
    return `
★★★ 수학/과학 퀴즈 특별 규칙 ★★★
- 교안의 예시 문제를 그대로 복사하지 마세요. 같은 개념을 활용한 새로운 수치/조건의 문제를 만드세요.
- 풀이 방법이나 단계를 묻는 문제 금지. 실제로 계산하여 답을 구하는 문제를 출제하세요.
- 교안의 보기 이름(기억, 니은, 디굿, 리울 등)이나 문제 번호를 사용하지 마세요.
- 좋은 예: "2x + y = 7이고 x - y = 2일 때, x의 값은?"
- 나쁜 예: "연립방정식을 풀 때 가장 중요한 고려 사항은?"
`;
  }

  /**
   * 영어 학습용 퀴즈 추가 지시사항
   */
  getEnglishLearningInstruction() {
    return `
★★★ 영어 학습 퀴즈 특별 규칙 (한국어 모국어 학습자 대상) ★★★
- 퀴즈는 한국어로 출제하되, 영어 표현/단어/문장은 영어 원문 그대로 포함하세요.
- 한국어 모국어 화자가 자주 틀리는 영어 표현, 문법, 어휘를 중점적으로 출제하세요.
- 유형 예시:
  · 어휘: "다음 중 'accomplish'의 의미로 가장 적절한 것은?"
  · 문법: "'She suggested that he ___ early.' 빈칸에 들어갈 표현은?"
  · 표현: "다음 중 'break a leg'의 올바른 의미는?"
  · 한영 비교: "'그는 회의에 참석했다'를 영어로 바르게 표현한 것은?"
  · 오류 수정: "다음 영어 문장 중 문법적으로 올바른 것은?"
- 선택지에 영어 표현을 포함할 때는 의미 차이가 명확하도록 구성하세요.
- 한국어 직역 오류, 콩글리시 표현 등을 오답 선택지로 활용하세요.
`;
  }

  /**
   * JSON 내 LaTeX 이스케이프 보정
   * LLM이 \\( 대신 \( 를 출력하면 JSON 파싱 에러 발생
   */
  fixJsonLatex(jsonStr) {
    // JSON 문자열 내에서 잘못된 이스케이프를 수정
    // \( → \\(, \) → \\), \[ → \\[, \] → \\], \frac → \\frac 등
    const fixed = jsonStr.replace(/\\(?!["\\/bfnrtu\\])/g, '\\\\');
    if (fixed !== jsonStr) {
      console.log('[QuizService] fixJsonLatex applied, diff chars:', fixed.length - jsonStr.length);
    }
    return fixed;
  }

  /**
   * Workers AI로 LLM 호출 (AI Gateway 사용)
   */
  async callWorkersAI(systemPrompt, userPrompt, requestType = 'quiz') {
    const startTime = Date.now();
    const result = await this.env.AI.run(
      this.model,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 2048,
        temperature: 0.7
      },
      {
        gateway: {
          id: 'malgn-chatbot',
          skipCache: true
        }
      }
    );

    // AI 사용 로그
    this.aiLogService.log({
      requestType,
      model: this.model,
      usage: result?.usage || {},
      latencyMs: Date.now() - startTime
    }).catch(() => {});

    return result.response || '';
  }

  /**
   * 4지선다 퀴즈 생성 (최대 2회 재시도)
   */
  async generateChoiceQuizzes(context, count, difficulty = 'normal') {
    const isEnglishLearning = this.detectEnglishLearning(context);
    const isMathScience = this.detectMathScience(context);
    if (isEnglishLearning) console.log('[QuizService] English learning content detected');
    if (isMathScience) console.log('[QuizService] Math/Science content detected');

    const systemPrompt = `교육 콘텐츠 기반 4지선다 퀴즈를 JSON으로 생성하세요.

형식:
[{"question": "질문", "options": ["A", "B", "C", "D"], "answer": 1, "explanation": "해설"}]

핵심 규칙:
1. 질문만 읽고 답을 고를 수 있어야 합니다. 필요한 조건/수치를 질문에 모두 포함하세요.
2. 질문은 2~3문장 이내로 짧고 명확하게 작성하세요. 풀이 과정, 해설, 다른 보기에 대한 설명을 질문에 절대 포함하지 마세요.
3. 교안의 보기 이름(기억, 니은, 디굿, 리우 등)이나 문제 번호(1번 문제, 2번 문제)를 사용하지 마세요. 구체적인 수식이나 값으로 직접 제시하세요.
4. 핵심 학습 내용만 출제하세요. 강의 안내, 훈련 순서, 인사말, 목차, 메타데이터 문제는 금지입니다.
5. options에 정확히 4개 선택지를 포함하세요. answer는 정답 번호(1~4)입니다.
6. 수학/과학 콘텐츠에서 question, options, explanation 모두 수식은 LaTeX로 작성하세요. 예: \\( x + y = 5 \\)
7. JSON 배열만 출력하세요. 다른 텍스트 없이 JSON만 응답하세요.

${this.getDifficultyInstruction(difficulty)}
${isEnglishLearning ? this.getEnglishLearningInstruction() : ''}
${isMathScience ? this.getMathScienceInstruction() : ''}`;

    const maxRetries = 3;
    const accumulated = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const remaining = count - accumulated.length;
      if (remaining <= 0) break;

      try {
        const content = await this.callWorkersAI(systemPrompt, `다음 내용을 바탕으로 4지선다 퀴즈 ${remaining}개를 생성해 주세요.
- 각 문제는 완전한 질문 형태로 작성
- 반드시 4개의 선택지 포함
- 선택지는 구체적인 내용으로 작성

내용:
${context.substring(0, 4000)}`, 'quiz_choice');

        // JSON 파싱 (```json ... ``` 제거, LaTeX 이스케이프 보정)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const rawJson = jsonMatch ? jsonMatch[0] : '[]';
        const jsonStr = this.fixJsonLatex(rawJson);
        const quizzes = JSON.parse(jsonStr);

        const valid = quizzes
          .filter(q => {
            if (!Array.isArray(q.options) || q.options.length !== 4) return false;
            // 중복 선택지 체크
            const unique = new Set(q.options.map(o => String(o).trim()));
            if (unique.size < 4) {
              console.log('[QuizService] Filtered duplicate options:', q.question?.substring(0, 50));
              return false;
            }
            return true;
          })
          .map(q => ({
            quiz_type: 'choice',
            question: q.question,
            options: JSON.stringify(q.options),
            answer: String(q.answer),
            explanation: q.explanation
          }));

        const filtered = this.filterIrrelevantQuizzes(valid);
        accumulated.push(...filtered);
        console.log(`[QuizService] Choice quiz attempt ${attempt}: +${filtered.length}, total ${accumulated.length}/${count}`);

        if (accumulated.length >= count) break;
      } catch (error) {
        console.error(`[QuizService] Choice quiz attempt ${attempt} error:`, error.message);
      }
    }

    if (accumulated.length === 0) {
      console.error('[QuizService] Choice quiz generation failed after', maxRetries, 'attempts');
    }
    return accumulated.slice(0, count);
  }

  /**
   * OX 퀴즈 생성 (최대 3회 재시도)
   */
  async generateOXQuizzes(context, count, difficulty = 'normal') {
    const isEnglishLearning = this.detectEnglishLearning(context);
    const isMathScience = this.detectMathScience(context);

    const englishOXExamples = isEnglishLearning ? `
★★★ 영어 학습 OX 퀴즈 예시 ★★★
{
  "question": "'I am looking forward to meet you'는 문법적으로 올바른 문장이다.",
  "answer": "X",
  "explanation": "'look forward to' 뒤에는 동명사(~ing)가 와야 합니다. 올바른 표현은 'I am looking forward to meeting you'입니다."
}
{
  "question": "영어에서 'He suggested that she go early'의 'go'는 가정법 현재로 사용된 것이다.",
  "answer": "O",
  "explanation": "suggest, recommend 등의 동사 뒤에 that절이 올 때 동사 원형을 사용하는 것은 가정법 현재(subjunctive mood)입니다."
}
` : '';

    const systemPrompt = `교육 콘텐츠 기반 OX 퀴즈를 JSON으로 생성하세요.

형식:
[{"question": "~은/는 ~이다.", "answer": "O", "explanation": "해설"}]

핵심 규칙:
1. "~이다.", "~한다.", "~있다." 등으로 끝나는 서술문만 작성하세요. 의문문(?) 금지.
2. 서술문만 읽고 O/X 판단이 가능해야 합니다. O와 X를 골고루 섞으세요.
3. 서술문은 1~2문장 이내로 짧고 명확하게 작성하세요. 풀이 과정이나 해설을 서술문에 포함하지 마세요.
4. 교안의 보기 이름이나 문제 번호를 사용하지 마세요. 구체적인 수식이나 값으로 직접 제시하세요.
5. 핵심 학습 내용만 출제하세요. 강의 안내, 훈련 순서, 인사말, 목차, 메타데이터 문제는 금지입니다.
6. 수학/과학 콘텐츠에서 question, explanation 모두 수식은 LaTeX로 작성하세요. 예: \\( x + y = 5 \\)
7. JSON 배열만 출력하세요. 다른 텍스트 없이 JSON만 응답하세요.
${englishOXExamples}
${this.getDifficultyInstruction(difficulty)}
${isEnglishLearning ? this.getEnglishLearningInstruction() : ''}
${isMathScience ? this.getMathScienceInstruction() : ''}`;

    const maxRetries = 3;
    const accumulated = [];
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const remaining = count - accumulated.length;
      if (remaining <= 0) break;

      try {
        const content = await this.callWorkersAI(systemPrompt, `다음 내용을 바탕으로 OX 퀴즈 ${remaining}개를 생성해 주세요.
- O와 X 문제를 골고루 섞어주세요
- 반드시 "~이다.", "~한다." 등으로 끝나는 서술문으로 작성
- 물음표(?)로 끝나는 의문문 절대 금지

내용:
${context.substring(0, 4000)}`, 'quiz_ox');

        // JSON 파싱 (```json ... ``` 제거, LaTeX 이스케이프 보정)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const jsonStr = this.fixJsonLatex(jsonMatch ? jsonMatch[0] : '[]');
        const quizzes = JSON.parse(jsonStr);

        // 유효성 검증: 의문문 필터링
        const valid = quizzes
          .filter(q => this.isValidOXQuestion(q.question) && (q.answer === 'O' || q.answer === 'X'))
          .map(q => ({
            quiz_type: 'ox',
            question: q.question,
            options: null,
            answer: q.answer,
            explanation: q.explanation
          }));

        const filtered = this.filterIrrelevantQuizzes(valid);
        accumulated.push(...filtered);
        console.log(`[QuizService] OX quiz attempt ${attempt}: +${filtered.length}, total ${accumulated.length}/${count}`);

        if (accumulated.length >= count) break;
      } catch (error) {
        console.error(`[QuizService] OX quiz attempt ${attempt} error:`, error.message);
      }
    }

    if (accumulated.length === 0) {
      console.error('[QuizService] OX quiz generation failed after', maxRetries, 'attempts');
    }
    return accumulated.slice(0, count);
  }

  /**
   * OX 퀴즈 질문 유효성 검증
   * - 의문문(?)이 아닌 서술문이어야 함
   * - "~이다", "~한다", "~있다", "~없다", "~된다" 등으로 끝나야 함
   */
  isValidOXQuestion(question) {
    if (!question || typeof question !== 'string') {
      return false;
    }

    const trimmed = question.trim();

    // 의문문 패턴 필터링
    const invalidPatterns = [
      /\?$/,                    // 물음표로 끝남
      /이란\??$/,               // "~이란" 또는 "~이란?"
      /란\s*무엇/,              // "~란 무엇"
      /무엇인가/,               // "~무엇인가"
      /^다음\s*중/,             // "다음 중~"
      /어느\s*것/,              // "어느 것"
      /고르시오/,               // "~고르시오"
      /선택하시오/,             // "~선택하시오"
    ];

    for (const pattern of invalidPatterns) {
      if (pattern.test(trimmed)) {
        return false;
      }
    }

    // 서술문 패턴 확인 (마침표로 끝나거나 서술형 어미로 끝남)
    const validEndings = [
      /다\.?$/,                 // "~다" 또는 "~다."
      /이다\.?$/,               // "~이다" 또는 "~이다."
      /한다\.?$/,               // "~한다"
      /있다\.?$/,               // "~있다"
      /없다\.?$/,               // "~없다"
      /된다\.?$/,               // "~된다"
      /않는다\.?$/,             // "~않는다"
      /아니다\.?$/,             // "~아니다"
    ];

    for (const pattern of validEndings) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 퀴즈 후처리 필터 - 강의 안내/메타데이터 퀴즈 제거
   */
  filterIrrelevantQuizzes(quizzes) {
    const blockedPatterns = [
      /기초훈련|기본훈련|응용훈련/,
      /몇\s*번.*문제.*풀/,
      /번부터.*번까지/,
      /문제를\s*풀어야/,
      /\d+번\s*문제를?\s*참고/,
      /\(\s*\d+번\s*문제/,
      /학습\s*목표/,
      /PDF|메타데이터|페이지\s*수/,
      /강사|선생님.*소개/,
      /수업\s*절차|수업\s*순서/,
    ];

    // 질문이 너무 긴 퀴즈 필터링 (200자 초과)
    const MAX_QUESTION_LENGTH = 200;

    return quizzes.filter(q => {
      const text = q.question || '';
      const blocked = blockedPatterns.some(p => p.test(text));
      const tooLong = text.length > MAX_QUESTION_LENGTH;
      if (blocked) {
        console.log('[QuizService] Filtered irrelevant quiz:', text.substring(0, 60));
      }
      if (tooLong) {
        console.log('[QuizService] Filtered long quiz (%d chars):', text.length, text.substring(0, 60));
      }
      return !blocked && !tooLong;
    });
  }

  /**
   * 퀴즈 DB 저장 (콘텐츠 + 세션 기반)
   */
  async saveQuizzesForContent(contentId, quizzes, sessionId = null) {
    for (let i = 0; i < quizzes.length; i++) {
      const quiz = quizzes[i];
      await this.env.DB
        .prepare(`
          INSERT INTO TB_QUIZ (content_id, session_id, quiz_type, question, options, answer, explanation, position, site_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          contentId,
          sessionId,
          quiz.quiz_type,
          quiz.question,
          quiz.options,
          quiz.answer,
          quiz.explanation,
          i + 1,
          this.siteId
        )
        .run();
    }
  }

  /**
   * 콘텐츠의 퀴즈 목록 조회
   */
  async getQuizzesByContent(contentId) {
    const { results } = await this.env.DB
      .prepare(`
        SELECT id, quiz_type, question, options, answer, explanation, position, created_at
        FROM TB_QUIZ
        WHERE content_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC
      `)
      .bind(contentId, this.siteId)
      .all();

    return (results || []).map(q => ({
      id: q.id,
      quizType: q.quiz_type,
      question: q.question,
      options: q.options ? JSON.parse(q.options) : null,
      answer: q.answer,
      explanation: q.explanation,
      position: q.position,
      createdAt: q.created_at
    }));
  }

  /**
   * 여러 콘텐츠의 퀴즈 목록 조회 (세션용)
   * @param {number[]} contentIds - 콘텐츠 ID 배열
   * @param {number} limit - 최대 퀴즈 수 (기본 전체)
   */
  async getQuizzesByContentIds(contentIds, limit = null) {
    if (!contentIds || contentIds.length === 0) {
      return [];
    }

    const placeholders = contentIds.map(() => '?').join(',');
    let query = `
      SELECT id, content_id, quiz_type, question, options, answer, explanation, position, created_at
      FROM TB_QUIZ
      WHERE content_id IN (${placeholders}) AND status = 1 AND site_id = ?
      ORDER BY content_id, position ASC
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    const { results } = await this.env.DB
      .prepare(query)
      .bind(...contentIds, this.siteId)
      .all();

    return (results || []).map(q => ({
      id: q.id,
      contentId: q.content_id,
      quizType: q.quiz_type,
      question: q.question,
      options: q.options ? JSON.parse(q.options) : null,
      answer: q.answer,
      explanation: q.explanation,
      position: q.position,
      createdAt: q.created_at
    }));
  }

  /**
   * 콘텐츠의 퀴즈 삭제
   */
  async deleteQuizzesByContent(contentId) {
    await this.env.DB
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE content_id = ? AND site_id = ?')
      .bind(contentId, this.siteId)
      .run();
  }

  // ─── 세션 퀴즈 (수동 추가) ──────────────────────

  /**
   * 세션에 퀴즈 추가
   * @param {number} sessionId - 세션 ID
   * @param {Object} quiz - 퀴즈 데이터
   * @returns {Object} 저장된 퀴즈
   */
  async addQuizToSession(sessionId, quiz) {
    let position;
    if (quiz.position !== undefined && quiz.position !== null && quiz.position > 0) {
      position = quiz.position;
    } else {
      // 현재 세션 퀴즈의 마지막 position 조회
      const last = await this.env.DB
        .prepare('SELECT MAX(position) as maxPos FROM TB_QUIZ WHERE session_id = ? AND status = 1 AND site_id = ?')
        .bind(sessionId, this.siteId)
        .first();
      position = (last?.maxPos || 0) + 1;
    }

    const options = quiz.options ? (typeof quiz.options === 'string' ? quiz.options : JSON.stringify(quiz.options)) : null;

    // content_id FK 제약 대응: 명시적 contentId가 없으면 세션 연결 콘텐츠의 첫 번째 ID 사용
    let contentId = quiz.contentId || null;
    if (!contentId) {
      const linked = await this.env.DB
        .prepare('SELECT content_id FROM TB_SESSION_CONTENT WHERE session_id = ? AND status = 1 AND site_id = ? LIMIT 1')
        .bind(sessionId, this.siteId)
        .first();
      contentId = linked?.content_id || null;
    }
    // 부모 세션 콘텐츠 조회
    if (!contentId) {
      const parent = await this.env.DB
        .prepare('SELECT parent_id FROM TB_SESSION WHERE id = ? AND site_id = ?')
        .bind(sessionId, this.siteId)
        .first();
      if (parent?.parent_id > 0) {
        const linked = await this.env.DB
          .prepare('SELECT content_id FROM TB_SESSION_CONTENT WHERE session_id = ? AND status = 1 AND site_id = ? LIMIT 1')
          .bind(parent.parent_id, this.siteId)
          .first();
        contentId = linked?.content_id || null;
      }
    }

    const insertResult = await this.env.DB
      .prepare(`
        INSERT INTO TB_QUIZ (content_id, session_id, quiz_type, question, options, answer, explanation, position, site_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(contentId, sessionId, quiz.quizType, quiz.question, options, quiz.answer, quiz.explanation || null, position, this.siteId)
      .run();

    return {
      id: insertResult.meta.last_row_id,
      sessionId,
      quizType: quiz.quizType,
      question: quiz.question,
      options: quiz.options || null,
      answer: quiz.answer,
      explanation: quiz.explanation || null,
      position
    };
  }

  /**
   * 세션의 직접 추가 퀴즈 조회
   * @param {number} sessionId - 세션 ID
   */
  async getQuizzesBySession(sessionId) {
    const { results } = await this.env.DB
      .prepare(`
        SELECT id, session_id, quiz_type, question, options, answer, explanation, position, created_at
        FROM TB_QUIZ
        WHERE session_id = ? AND status = 1 AND site_id = ?
        ORDER BY position ASC
      `)
      .bind(sessionId, this.siteId)
      .all();

    return (results || []).map(q => ({
      id: q.id,
      sessionId: q.session_id,
      quizType: q.quiz_type,
      question: q.question,
      options: q.options ? JSON.parse(q.options) : null,
      answer: q.answer,
      explanation: q.explanation,
      position: q.position,
      createdAt: q.created_at
    }));
  }

  /**
   * 세션 퀴즈 수정
   * @param {number} quizId - 퀴즈 ID
   * @param {number} sessionId - 세션 ID (소유 확인)
   * @param {Object} updates - 수정할 필드 (전달된 것만 업데이트)
   * @returns {Object|null} 수정된 퀴즈 또는 null
   */
  async updateSessionQuiz(quizId, sessionId, updates) {
    const quiz = await this.env.DB
      .prepare('SELECT * FROM TB_QUIZ WHERE id = ? AND session_id = ? AND status = 1 AND site_id = ?')
      .bind(quizId, sessionId, this.siteId)
      .first();

    if (!quiz) return null;

    const quizType = updates.quizType || quiz.quiz_type;
    const question = updates.question || quiz.question;
    const answer = updates.answer || quiz.answer;
    const explanation = updates.explanation !== undefined ? updates.explanation : quiz.explanation;
    const position = updates.position !== undefined && updates.position !== null ? updates.position : quiz.position;
    const options = updates.options !== undefined
      ? (Array.isArray(updates.options) ? JSON.stringify(updates.options) : updates.options)
      : quiz.options;

    await this.env.DB
      .prepare('UPDATE TB_QUIZ SET quiz_type = ?, question = ?, options = ?, answer = ?, explanation = ?, position = ? WHERE id = ?')
      .bind(quizType, question, options, answer, explanation, position, quizId)
      .run();

    return {
      id: quizId,
      sessionId,
      quizType,
      question,
      options: options ? JSON.parse(options) : null,
      answer,
      explanation,
      position
    };
  }

  /**
   * 세션 퀴즈 개별 삭제
   * @param {number} quizId - 퀴즈 ID
   * @param {number} sessionId - 세션 ID (소유 확인)
   */
  async deleteSessionQuiz(quizId, sessionId) {
    const quiz = await this.env.DB
      .prepare('SELECT id FROM TB_QUIZ WHERE id = ? AND session_id = ? AND status = 1 AND site_id = ?')
      .bind(quizId, sessionId, this.siteId)
      .first();

    if (!quiz) return false;

    await this.env.DB
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE id = ?')
      .bind(quizId)
      .run();
    return true;
  }

  /**
   * 세션의 직접 추가 퀴즈 전체 삭제
   * @param {number} sessionId - 세션 ID
   */
  async deleteQuizzesBySession(sessionId) {
    await this.env.DB
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE session_id = ? AND content_id = 0 AND site_id = ?')
      .bind(sessionId, this.siteId)
      .run();
  }
}
