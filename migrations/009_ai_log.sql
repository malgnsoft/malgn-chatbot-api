-- 009: AI 사용 로그 테이블
-- 토큰 사용량, 뉴런 소비량, 예상 비용을 기록

CREATE TABLE IF NOT EXISTS TB_AI_LOG (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  content_id INTEGER,
  request_type TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  neurons REAL DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_ai_log_site_id ON TB_AI_LOG(site_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_request_type ON TB_AI_LOG(request_type);
CREATE INDEX IF NOT EXISTS idx_ai_log_session_id ON TB_AI_LOG(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_created_at ON TB_AI_LOG(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_log_site_created ON TB_AI_LOG(site_id, created_at DESC);
