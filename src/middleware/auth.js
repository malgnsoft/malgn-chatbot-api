/**
 * API Key Authentication middleware
 * Verifies API key from Authorization header against environment variable
 */
export const authMiddleware = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: '인증이 필요합니다.'
      }
    }, 401);
  }

  let apiKey = authHeader.substring(7);

  // "API_KEY=" 접두어가 포함된 경우 자동 제거 (Swagger UI 입력 실수 대응)
  if (apiKey.startsWith('API_KEY=')) {
    apiKey = apiKey.substring(8);
  }

  if (!c.env.API_KEY) {
    console.error('API_KEY is not configured');
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: '인증 설정 오류가 발생했습니다.'
      }
    }, 401);
  }

  if (apiKey !== c.env.API_KEY) {
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: '유효하지 않은 API Key입니다.'
      }
    }, 401);
  }

  await next();
};
