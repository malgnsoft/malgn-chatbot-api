/**
 * Embedding Service
 *
 * 텍스트를 벡터(숫자 배열)로 변환하는 서비스입니다.
 * Cloudflare Workers AI를 사용합니다. (지역 제한 없음)
 *
 * 사용 모델: @cf/baai/bge-m3 (1024차원, 다국어 지원)
 */
export class EmbeddingService {
  constructor(env) {
    this.env = env;
    this.model = '@cf/baai/bge-m3';
  }

  /**
   * 텍스트를 임베딩 벡터로 변환
   * @param {string} text - 변환할 텍스트
   * @returns {Promise<number[]>} - 1024차원 벡터
   */
  async embed(text) {
    if (!text || text.trim().length === 0) {
      throw new Error('텍스트가 비어있습니다.');
    }

    try {
      // Workers AI를 사용하여 임베딩 생성
      const result = await this.env.AI.run(this.model, {
        text: text
      }, {
        gateway: { id: 'malgn-chatbot' }
      });

      if (result && result.data && result.data.length > 0) {
        return result.data[0];
      }

      throw new Error('임베딩 결과가 없습니다.');
    } catch (error) {
      console.error('Embedding error:', error);
      throw new Error(`임베딩 생성 실패: ${error.message}`);
    }
  }

  /**
   * 텍스트를 청크로 분할
   * @param {string} text - 분할할 텍스트
   * @param {number} maxChars - 청크 최대 문자 수
   * @param {number} overlap - 오버랩 문자 수
   * @returns {{ text: string, offset: number }[]}
   */
  splitIntoChunks(text, maxChars = 500, overlap = 100) {
    if (!text || text.trim().length === 0) return [];

    const trimmed = text.trim();

    // 짧은 텍스트는 하나의 청크로
    if (trimmed.length <= maxChars) {
      return [{ text: trimmed, offset: 0 }];
    }

    // 문장 단위로 분할 (마침표, 물음표, 느낌표, 줄바꿈 기준)
    const sentences = trimmed.split(/(?<=[.?!。\n])\s*/);

    const chunks = [];
    let currentChunk = '';
    let currentOffset = 0;
    let charPos = 0;

    for (const sentence of sentences) {
      if (!sentence.trim()) {
        charPos += sentence.length;
        continue;
      }

      // 현재 청크 + 새 문장이 maxChars를 초과하면 청크 저장
      if (currentChunk.length > 0 && currentChunk.length + sentence.length > maxChars) {
        chunks.push({ text: currentChunk.trim(), offset: currentOffset });

        // 오버랩: 현재 청크 끝부분에서 overlap만큼 가져오기
        const overlapText = currentChunk.slice(-overlap);
        const overlapStart = charPos - overlapText.length;
        currentChunk = overlapText + sentence;
        currentOffset = overlapStart;
      } else {
        if (currentChunk.length === 0) {
          currentOffset = charPos;
        }
        currentChunk += sentence;
      }

      charPos += sentence.length;
    }

    // 마지막 청크
    if (currentChunk.trim().length > 0) {
      chunks.push({ text: currentChunk.trim(), offset: currentOffset });
    }

    return chunks;
  }
}
