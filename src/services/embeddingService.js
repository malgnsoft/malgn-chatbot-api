/**
 * Embedding Service
 *
 * 텍스트를 벡터(숫자 배열)로 변환하는 서비스입니다.
 * OpenAI의 임베딩 모델을 사용합니다.
 *
 * 사용 모델: text-embedding-3-small (1536차원)
 */
export class EmbeddingService {
  constructor(env) {
    this.env = env;
    this.model = 'text-embedding-3-small';
    // AI Gateway를 통해 OpenAI 호출 (지역 제한 우회)
    this.apiUrl = env.AI_GATEWAY_URL
      ? `${env.AI_GATEWAY_URL}/openai/v1/embeddings`
      : 'https://api.openai.com/v1/embeddings';
  }

  /**
   * 텍스트를 임베딩 벡터로 변환
   * @param {string} text - 변환할 텍스트
   * @returns {Promise<number[]>} - 1536차원 벡터
   */
  async embed(text) {
    if (!text || text.trim().length === 0) {
      throw new Error('텍스트가 비어있습니다.');
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          input: text
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API 오류');
      }

      const result = await response.json();

      if (result.data && result.data.length > 0) {
        return result.data[0].embedding;
      }

      throw new Error('임베딩 결과가 없습니다.');
    } catch (error) {
      console.error('Embedding error:', error);
      throw new Error(`임베딩 생성 실패: ${error.message}`);
    }
  }
}
