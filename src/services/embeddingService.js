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
    this.apiUrl = 'https://api.openai.com/v1/embeddings';
  }

  /**
   * 단일 텍스트를 임베딩 벡터로 변환
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

  /**
   * 여러 텍스트를 임베딩 벡터로 변환 (배치 처리)
   * OpenAI API는 한 번에 여러 텍스트를 처리할 수 있습니다.
   * @param {string[]} texts - 변환할 텍스트 배열
   * @param {number} batchSize - 한 번에 처리할 텍스트 수 (기본값: 100)
   * @returns {Promise<number[][]>} - 벡터 배열
   */
  async embedBatch(texts, batchSize = 100) {
    if (!texts || texts.length === 0) {
      throw new Error('텍스트 배열이 비어있습니다.');
    }

    try {
      const allEmbeddings = [];

      // 텍스트를 배치로 나누어 처리
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)`);

        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: this.model,
            input: batch
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || 'OpenAI API 오류');
        }

        const result = await response.json();

        if (result.data && result.data.length > 0) {
          // OpenAI는 인덱스 순서대로 반환하지 않을 수 있으므로 정렬
          const sorted = result.data.sort((a, b) => a.index - b.index);
          allEmbeddings.push(...sorted.map(d => d.embedding));
        } else {
          throw new Error(`배치 ${Math.floor(i / batchSize) + 1} 임베딩 결과가 없습니다.`);
        }
      }

      if (allEmbeddings.length !== texts.length) {
        throw new Error(`임베딩 수(${allEmbeddings.length})가 입력 텍스트 수(${texts.length})와 일치하지 않습니다.`);
      }

      return allEmbeddings;
    } catch (error) {
      console.error('Batch embedding error:', error);
      throw new Error(`배치 임베딩 생성 실패: ${error.message}`);
    }
  }

  /**
   * 텍스트를 청크로 분할
   * @param {string} text - 분할할 텍스트
   * @param {number} chunkSize - 청크당 최대 문자 수 (기본값: 500)
   * @param {number} overlap - 청크 간 중복 문자 수 (기본값: 50)
   * @returns {string[]} - 청크 배열
   */
  splitIntoChunks(text, chunkSize = 500, overlap = 50) {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const chunks = [];
    const cleanText = text.replace(/\s+/g, ' ').trim();

    let start = 0;
    while (start < cleanText.length) {
      let end = start + chunkSize;

      // 문장 경계에서 자르기 시도
      if (end < cleanText.length) {
        // 마지막 마침표, 물음표, 느낌표 찾기
        const lastSentenceEnd = cleanText.substring(start, end).search(/[.!?。？！]\s*$/);
        if (lastSentenceEnd > chunkSize * 0.5) {
          end = start + lastSentenceEnd + 1;
        }
      }

      const chunk = cleanText.substring(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      start = end - overlap;
      if (start >= cleanText.length) break;
    }

    return chunks;
  }
}
