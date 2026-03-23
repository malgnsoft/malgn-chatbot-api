/**
 * Quiz Service
 *
 * 학습 콘텐츠를 기반으로 퀴즈를 생성하는 서비스입니다.
 * Cloudflare Workers AI를 사용하여 4지선다와 OX퀴즈를 생성합니다.
 *
 * 퀴즈는 콘텐츠 업로드 시 생성되어 TB_QUIZ에 content_id로 저장됩니다.
 * 세션 생성 시에는 연결된 콘텐츠의 퀴즈를 조회하여 사용합니다.
 */
export class QuizService {
  constructor(env) {
    this.env = env;
    // 70B 모델로 더 정확한 퀴즈 생성
    this.model = '@cf/meta/llama-3.1-70b-instruct';
  }

  /**
   * 콘텐츠 기반으로 퀴즈 생성 (콘텐츠 업로드 시 호출)
   * @param {number} contentId - 콘텐츠 ID
   * @param {string} content - 콘텐츠 텍스트
   * @param {Object|number} quizOptions - 퀴즈 옵션 또는 총 퀴즈 수 (하위 호환)
   * @param {number} quizOptions.choiceCount - 4지선다 퀴즈 수 (기본 3개)
   * @param {number} quizOptions.oxCount - OX 퀴즈 수 (기본 2개)
   * @returns {Promise<Object[]>} - 생성된 퀴즈 배열
   */
  async generateQuizzesForContent(contentId, content, quizOptions = {}) {
    if (!content || content.trim().length === 0) {
      console.log('[QuizService] No content provided, skipping quiz generation');
      return [];
    }

    // 콘텐츠가 너무 짧으면 스킵
    if (content.trim().length < 100) {
      console.log('[QuizService] Content too short for quiz generation');
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

    // 4지선다 퀴즈 생성
    if (choiceCount > 0) {
      const choiceQuizzes = await this.generateChoiceQuizzes(content, choiceCount, difficulty);
      quizzes.push(...choiceQuizzes);
    }

    // OX 퀴즈 생성
    if (oxCount > 0) {
      const oxQuizzes = await this.generateOXQuizzes(content, oxCount, difficulty);
      quizzes.push(...oxQuizzes);
    }

    // DB에 저장
    if (quizzes.length > 0) {
      await this.saveQuizzesForContent(contentId, quizzes);
      console.log('[QuizService] Saved', quizzes.length, 'quizzes for content', contentId);
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
        WHERE id IN (${placeholders}) AND status = 1
      `)
      .bind(...contentIds)
      .all();

    return (results || []).map(r => r.content).filter(c => c).join('\n\n');
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
    // 영어 학습 관련 키워드 패턴
    const englishLearningPatterns = [
      /\b(vocabulary|grammar|pronunciation|listening|speaking|reading|writing)\b/i,
      /\b(verb|noun|adjective|adverb|preposition|conjunction)\b/i,
      /\b(tense|past tense|present tense|future tense)\b/i,
      /\b(sentence|clause|phrase|paragraph)\b/i,
      /영어|English|영문법|영단어|영어회화|어휘|문법|발음|듣기|말하기|읽기|쓰기/,
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
   * Workers AI로 LLM 호출 (AI Gateway 사용)
   */
  async callWorkersAI(systemPrompt, userPrompt) {
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
          skipCache: false
        }
      }
    );

    return result.response || '';
  }

  /**
   * 4지선다 퀴즈 생성 (최대 2회 재시도)
   */
  async generateChoiceQuizzes(context, count, difficulty = 'normal') {
    const isEnglishLearning = this.detectEnglishLearning(context);
    if (isEnglishLearning) {
      console.log('[QuizService] English learning content detected');
    }

    const systemPrompt = `당신은 교육 콘텐츠 전문가입니다. 주어진 내용을 바탕으로 4지선다 퀴즈를 생성해 주세요.

반드시 아래 JSON 형식으로만 응답하세요:
[
  {
    "question": "질문 내용",
    "options": ["선택지1", "선택지2", "선택지3", "선택지4"],
    "answer": 1,
    "explanation": "정답 해설"
  }
]

★★★ 좋은 퀴즈 예시 ★★★
{
  "question": "다음 중 '절(Clause)'의 특징으로 올바른 것은?",
  "options": ["의미를 나타내는 글자이다", "주어와 동사가 없다", "주어와 동사가 있으며 문장의 형태를 가진다", "단어 하나로 이루어진다"],
  "answer": 3,
  "explanation": "절은 두 개 이상의 단어들의 연결로, 주어와 동사가 나타나며 문장의 형태를 가집니다."
}

★★★ 나쁜 퀴즈 예시 (이렇게 만들지 마세요) ★★★
{
  "question": "단어, 구, 절 중 어느 것인지 고르시오.",  <- 무엇에 대한 질문인지 불명확
  "options": ["단어", "구", "절", "별도 선택"],
  ...
}

규칙:
1. answer는 정답 선택지의 번호입니다 (1, 2, 3, 4 중 하나)
2. options 배열에는 반드시 정확히 4개의 선택지가 포함되어야 합니다
3. 질문은 반드시 완전한 문장으로 작성하고, 무엇을 묻는지 명확해야 합니다
4. "다음 중 ~에 대한 설명으로 올바른 것은?", "~의 특징은 무엇인가?" 형태로 질문하세요
5. 선택지에 "별도 선택", "해당 없음" 같은 모호한 답 금지
6. 제공된 내용에 기반한 문제만 출제하세요
7. JSON 배열만 출력하세요
8. ★★★ PDF 메타데이터(작성자, 저자, 출판사, 발행일, 페이지 번호, 파일명, 문서 제목, 저작권 표시, ISBN, 머리글/바닥글 등)에 대한 문제는 절대 출제하지 마세요. 학습 내용 본문에 기반한 문제만 출제하세요.
9. ★★★ 각 선택지는 반드시 짧고 명확한 하나의 개념/문장이어야 합니다. 쉼표로 여러 항목을 나열하지 마세요.
   - 나쁜 예: "오늘의 공부, 자기소개하는 글 읽기, 자기소개 담화 완성하기를 공부"
   - 좋은 예: "자기소개하는 글 읽기"
10. 학습 목표 목록, 목차, 차례 등을 그대로 선택지로 사용하지 마세요. 핵심 개념에 대한 이해도를 측정하는 문제를 출제하세요.

${this.getDifficultyInstruction(difficulty)}
${isEnglishLearning ? this.getEnglishLearningInstruction() : ''}`;

    const userPrompt = `다음 내용을 바탕으로 4지선다 퀴즈 ${count}개를 생성해 주세요.
- 각 문제는 완전한 질문 형태로 작성
- 반드시 4개의 선택지 포함
- 선택지는 구체적인 내용으로 작성

내용:
${context.substring(0, 4000)}`;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const content = await this.callWorkersAI(systemPrompt, userPrompt);

        // JSON 파싱 (```json ... ``` 제거)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const quizzes = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');

        const valid = quizzes
          .filter(q => Array.isArray(q.options) && q.options.length === 4)
          .map(q => ({
            quiz_type: 'choice',
            question: q.question,
            options: JSON.stringify(q.options),
            answer: String(q.answer),
            explanation: q.explanation
          }));

        if (valid.length > 0) {
          console.log(`[QuizService] Choice quiz attempt ${attempt}: ${valid.length}/${count} valid`);
          return valid;
        }

        console.warn(`[QuizService] Choice quiz attempt ${attempt}: no valid quizzes (all filtered), retrying...`);
      } catch (error) {
        console.error(`[QuizService] Choice quiz attempt ${attempt} error:`, error.message);
      }
    }

    console.error('[QuizService] Choice quiz generation failed after', maxRetries, 'attempts');
    return [];
  }

  /**
   * OX 퀴즈 생성 (최대 3회 재시도)
   */
  async generateOXQuizzes(context, count, difficulty = 'normal') {
    const isEnglishLearning = this.detectEnglishLearning(context);

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

    const systemPrompt = `당신은 교육 콘텐츠 전문가입니다. 주어진 내용을 바탕으로 OX 퀴즈를 생성해 주세요.

반드시 아래 JSON 형식으로만 응답하세요:
[
  {
    "question": "~은/는 ~이다.",
    "answer": "O",
    "explanation": "정답 해설"
  }
]

★★★ 좋은 OX 퀴즈 예시 ★★★
{
  "question": "절(Clause)은 주어와 동사가 포함된 단어들의 연결이다.",
  "answer": "O",
  "explanation": "절은 두 개 이상의 단어들이 연결되어 있으며, 주어와 동사가 나타나고 문장의 형태를 가집니다."
}

{
  "question": "구(Phrase)는 반드시 주어와 동사를 포함해야 한다.",
  "answer": "X",
  "explanation": "구는 두 개 이상의 단어들의 연결이지만, 주어와 동사가 반드시 필요하지 않습니다. 주어와 동사가 있으면 절이 됩니다."
}
${englishOXExamples}
★★★ 나쁜 OX 퀴즈 예시 (이렇게 만들지 마세요) ★★★
{
  "question": "문학이란?",  <- 의문문은 O/X로 판단할 수 없음
  ...
}
{
  "question": "다음 중 올바른 것은?",  <- 선택형 질문은 O/X 퀴즈가 아님
  ...
}
{
  "question": "문학의 정의",  <- 명사구는 서술문이 아님
  ...
}

규칙:
1. answer는 "O" 또는 "X"입니다
2. ★★★ 중요: 문제는 반드시 "~이다.", "~한다.", "~있다." 등으로 끝나는 완전한 서술문이어야 합니다
3. ★★★ 금지: 물음표(?), "~이란", "~란 무엇", "다음 중" 등 의문문/선택형 질문 절대 금지
4. 참/거짓이 명확하게 판단 가능해야 합니다
5. O와 X 문제를 적절히 섞어서 출제하세요
6. 제공된 내용에 기반한 문제만 출제하세요
7. JSON 배열만 출력하세요
8. ★★★ PDF 메타데이터(작성자, 저자, 출판사, 발행일, 페이지 번호, 파일명, 문서 제목, 저작권 표시, ISBN, 머리글/바닥글 등)에 대한 문제는 절대 출제하지 마세요. 학습 내용 본문에 기반한 문제만 출제하세요.

${this.getDifficultyInstruction(difficulty)}
${isEnglishLearning ? this.getEnglishLearningInstruction() : ''}`;

    const userPrompt = `다음 내용을 바탕으로 OX 퀴즈 ${count}개를 생성해 주세요.
- O와 X 문제를 골고루 섞어주세요
- 반드시 "~이다.", "~한다." 등으로 끝나는 서술문으로 작성
- 물음표(?)로 끝나는 의문문 절대 금지

내용:
${context.substring(0, 4000)}`;

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const content = await this.callWorkersAI(systemPrompt, userPrompt);

        // JSON 파싱 (```json ... ``` 제거)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const quizzes = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');

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

        if (valid.length > 0) {
          console.log(`[QuizService] OX quiz attempt ${attempt}: ${valid.length}/${count} valid`);
          return valid;
        }

        console.warn(`[QuizService] OX quiz attempt ${attempt}: no valid quizzes, retrying...`);
      } catch (error) {
        console.error(`[QuizService] OX quiz attempt ${attempt} error:`, error.message);
      }
    }

    console.error('[QuizService] OX quiz generation failed after', maxRetries, 'attempts');
    return [];
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
   * 퀴즈 DB 저장 (콘텐츠 기반)
   */
  async saveQuizzesForContent(contentId, quizzes) {
    for (let i = 0; i < quizzes.length; i++) {
      const quiz = quizzes[i];
      await this.env.DB
        .prepare(`
          INSERT INTO TB_QUIZ (content_id, quiz_type, question, options, answer, explanation, position)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          contentId,
          quiz.quiz_type,
          quiz.question,
          quiz.options,
          quiz.answer,
          quiz.explanation,
          i + 1
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
        WHERE content_id = ? AND status = 1
        ORDER BY position ASC
      `)
      .bind(contentId)
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
      WHERE content_id IN (${placeholders}) AND status = 1
      ORDER BY content_id, position ASC
    `;

    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    const { results } = await this.env.DB
      .prepare(query)
      .bind(...contentIds)
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
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE content_id = ?')
      .bind(contentId)
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
    // 현재 세션 퀴즈의 마지막 position 조회
    const last = await this.env.DB
      .prepare('SELECT MAX(position) as maxPos FROM TB_QUIZ WHERE session_id = ? AND status = 1')
      .bind(sessionId)
      .first();
    const position = (last?.maxPos || 0) + 1;

    const options = quiz.options ? (typeof quiz.options === 'string' ? quiz.options : JSON.stringify(quiz.options)) : null;

    const result = await this.env.DB
      .prepare(`
        INSERT INTO TB_QUIZ (content_id, session_id, quiz_type, question, options, answer, explanation, position)
        VALUES (0, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(sessionId, quiz.quizType, quiz.question, options, quiz.answer, quiz.explanation || null, position)
      .run();

    return {
      id: result.meta.last_row_id,
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
        WHERE session_id = ? AND status = 1
        ORDER BY position ASC
      `)
      .bind(sessionId)
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
   * 세션 퀴즈 개별 삭제
   * @param {number} quizId - 퀴즈 ID
   * @param {number} sessionId - 세션 ID (소유 확인)
   */
  async deleteSessionQuiz(quizId, sessionId) {
    const quiz = await this.env.DB
      .prepare('SELECT id FROM TB_QUIZ WHERE id = ? AND session_id = ? AND status = 1')
      .bind(quizId, sessionId)
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
      .prepare('UPDATE TB_QUIZ SET status = -1 WHERE session_id = ? AND content_id = 0')
      .bind(sessionId)
      .run();
  }
}
