/**
 * AI Log Service
 *
 * AI 호출 시 토큰 사용량, 뉴런 소비량, 예상 비용을 DB에 기록합니다.
 * waitUntil()로 비동기 저장하여 응답 속도에 영향을 주지 않습니다.
 */
export class AiLogService {
  constructor(env, siteId = 0) {
    this.env = env;
    this.siteId = siteId;

    // 모델별 뉴런 환산 계수 (1M 토큰당 뉴런)
    this.neuronRates = {
      // Gemma 3 12B (채팅/학습/퀴즈)
      '@cf/google/gemma-3-12b-it': { input: 410, output: 1600 },
      // Mistral Small 3.1 24B
      '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 580, output: 2200 },
      // BGE-M3 (임베딩)
      '@cf/baai/bge-m3': { input: 35, output: 0 },
    };

    // 초과 뉴런 비용: $0.011 / 1,000 뉴런
    this.costPerNeuron = 0.011 / 1000;
  }

  /**
   * 뉴런 수 계산
   */
  calculateNeurons(model, promptTokens, completionTokens) {
    const rates = this.neuronRates[model];
    if (!rates) return 0;

    const inputNeurons = (promptTokens / 1_000_000) * rates.input;
    const outputNeurons = (completionTokens / 1_000_000) * rates.output;
    return inputNeurons + outputNeurons;
  }

  /**
   * 예상 비용 계산 ($)
   */
  calculateCost(neurons) {
    return neurons * this.costPerNeuron;
  }

  /**
   * AI 사용 로그 저장
   * @param {Object} params
   * @param {number} params.sessionId - 세션 ID
   * @param {number} params.contentId - 콘텐츠 ID
   * @param {string} params.requestType - 요청 유형 (chat, learning, quiz_choice, quiz_ox, embedding)
   * @param {string} params.model - AI 모델명
   * @param {Object} params.usage - { prompt_tokens, completion_tokens, total_tokens }
   * @param {number} params.latencyMs - 응답 시간 (ms)
   */
  async log({ sessionId = null, contentId = null, requestType, model, usage = {}, latencyMs = 0 }) {
    try {
      const promptTokens = usage.prompt_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
      const neurons = this.calculateNeurons(model, promptTokens, completionTokens);
      const estimatedCost = this.calculateCost(neurons);

      await this.env.DB
        .prepare(`
          INSERT INTO TB_AI_LOG (session_id, content_id, request_type, model, prompt_tokens, completion_tokens, total_tokens, neurons, estimated_cost, latency_ms, site_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          sessionId, contentId, requestType, model,
          promptTokens, completionTokens, totalTokens,
          Math.round(neurons * 10000) / 10000,
          Math.round(estimatedCost * 100000000) / 100000000,
          latencyMs,
          this.siteId
        )
        .run();
    } catch (error) {
      console.error('[AiLogService] Log save error:', error.message);
    }
  }

  /**
   * AI 로그 목록 조회 (기간별, 타입별 필터)
   */
  async getLogs({ page = 1, limit = 50, requestType = null, startDate = null, endDate = null } = {}) {
    const conditions = ['site_id = ?'];
    const params = [this.siteId];

    if (requestType) {
      conditions.push('request_type = ?');
      params.push(requestType);
    }
    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countResult = await this.env.DB
      .prepare(`SELECT COUNT(*) as total FROM TB_AI_LOG WHERE ${whereClause}`)
      .bind(...params)
      .first();

    const { results } = await this.env.DB
      .prepare(`
        SELECT id, session_id, content_id, request_type, model,
               prompt_tokens, completion_tokens, total_tokens,
               neurons, estimated_cost, latency_ms, created_at
        FROM TB_AI_LOG
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(...params, limit, offset)
      .all();

    return {
      logs: results || [],
      pagination: {
        page,
        limit,
        total: countResult?.total || 0,
        totalPages: Math.ceil((countResult?.total || 0) / limit)
      }
    };
  }

  /**
   * AI 사용량 요약 (기간별 집계)
   */
  async getSummary({ startDate = null, endDate = null } = {}) {
    const conditions = ['site_id = ?'];
    const params = [this.siteId];

    if (startDate) {
      conditions.push('created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('created_at <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.join(' AND ');

    const { results } = await this.env.DB
      .prepare(`
        SELECT
          request_type,
          COUNT(*) as count,
          SUM(prompt_tokens) as total_prompt_tokens,
          SUM(completion_tokens) as total_completion_tokens,
          SUM(total_tokens) as total_tokens,
          SUM(neurons) as total_neurons,
          SUM(estimated_cost) as total_cost,
          AVG(latency_ms) as avg_latency_ms
        FROM TB_AI_LOG
        WHERE ${whereClause}
        GROUP BY request_type
        ORDER BY count DESC
      `)
      .bind(...params)
      .all();

    // 전체 합계
    const totals = (results || []).reduce((acc, row) => {
      acc.totalRequests += row.count;
      acc.totalTokens += row.total_tokens;
      acc.totalNeurons += row.total_neurons;
      acc.totalCost += row.total_cost;
      return acc;
    }, { totalRequests: 0, totalTokens: 0, totalNeurons: 0, totalCost: 0 });

    return {
      byType: results || [],
      totals
    };
  }
}
