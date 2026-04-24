-- ============================================
-- AI Chatbot Database Schema (PostgreSQL / Aurora)
-- ============================================
-- status: 1(정상), 0(중지), -1(삭제)

-- TB_CONTENT: 학습 콘텐츠
CREATE TABLE IF NOT EXISTS TB_CONTENT (
  id SERIAL PRIMARY KEY,
  content_nm VARCHAR(500) NOT NULL,
  filename VARCHAR(1000) NOT NULL,
  file_type VARCHAR(20) NOT NULL,
  file_size INTEGER NOT NULL,
  content TEXT,
  lesson_id INTEGER DEFAULT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_content_created_at ON TB_CONTENT(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_status ON TB_CONTENT(status);
CREATE INDEX IF NOT EXISTS idx_content_lesson_id ON TB_CONTENT(lesson_id);
CREATE INDEX IF NOT EXISTS idx_content_site_id ON TB_CONTENT(site_id);

-- TB_SESSION: 채팅 세션
CREATE TABLE IF NOT EXISTS TB_SESSION (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER DEFAULT 0,
  course_id INTEGER DEFAULT NULL,
  course_user_id INTEGER DEFAULT NULL,
  lesson_id INTEGER DEFAULT NULL,
  user_id INTEGER DEFAULT NULL,
  session_nm VARCHAR(500) DEFAULT NULL,
  persona TEXT DEFAULT NULL,
  temperature DOUBLE PRECISION DEFAULT 0.3,
  top_p DOUBLE PRECISION DEFAULT 0.3,
  max_tokens INTEGER DEFAULT 1024,
  summary_count INTEGER DEFAULT 3,
  recommend_count INTEGER DEFAULT 3,
  choice_count INTEGER DEFAULT 3,
  ox_count INTEGER DEFAULT 2,
  quiz_difficulty VARCHAR(20) DEFAULT 'normal',
  learning_goal TEXT DEFAULT NULL,
  learning_summary TEXT DEFAULT NULL,
  recommended_questions TEXT DEFAULT NULL,
  chat_content_ids TEXT DEFAULT NULL,
  welcome_message TEXT DEFAULT NULL,
  generation_status VARCHAR(20) DEFAULT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_status ON TB_SESSION(status);
CREATE INDEX IF NOT EXISTS idx_session_user ON TB_SESSION(user_id);
CREATE INDEX IF NOT EXISTS idx_session_parent_id ON TB_SESSION(parent_id);
CREATE INDEX IF NOT EXISTS idx_session_parent_course_user ON TB_SESSION(parent_id, course_user_id);
CREATE INDEX IF NOT EXISTS idx_session_site_id ON TB_SESSION(site_id);

-- TB_MESSAGE: 채팅 메시지
CREATE TABLE IF NOT EXISTS TB_MESSAGE (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES TB_SESSION(id) ON DELETE CASCADE,
  user_id INTEGER DEFAULT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_session ON TB_MESSAGE(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_status ON TB_MESSAGE(status);
CREATE INDEX IF NOT EXISTS idx_message_user ON TB_MESSAGE(user_id);
CREATE INDEX IF NOT EXISTS idx_message_site_id ON TB_MESSAGE(site_id);

-- TB_SESSION_CONTENT: 세션-콘텐츠 연결
CREATE TABLE IF NOT EXISTS TB_SESSION_CONTENT (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES TB_SESSION(id) ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES TB_CONTENT(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, content_id)
);

CREATE INDEX IF NOT EXISTS idx_session_content_session ON TB_SESSION_CONTENT(session_id);
CREATE INDEX IF NOT EXISTS idx_session_content_content ON TB_SESSION_CONTENT(content_id);
CREATE INDEX IF NOT EXISTS idx_session_content_status ON TB_SESSION_CONTENT(status);
CREATE INDEX IF NOT EXISTS idx_session_content_site_id ON TB_SESSION_CONTENT(site_id);

-- TB_QUIZ: 퀴즈
CREATE TABLE IF NOT EXISTS TB_QUIZ (
  id SERIAL PRIMARY KEY,
  content_id INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER DEFAULT NULL,
  quiz_type VARCHAR(10) NOT NULL,
  question TEXT NOT NULL,
  options TEXT DEFAULT NULL,
  answer VARCHAR(100) NOT NULL,
  explanation TEXT DEFAULT NULL,
  position INTEGER NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quiz_content ON TB_QUIZ(content_id, position);
CREATE INDEX IF NOT EXISTS idx_quiz_session ON TB_QUIZ(session_id, position);
CREATE INDEX IF NOT EXISTS idx_quiz_status ON TB_QUIZ(status);
CREATE INDEX IF NOT EXISTS idx_quiz_site_id ON TB_QUIZ(site_id);

-- TB_AI_LOG: AI 사용 로그
CREATE TABLE IF NOT EXISTS TB_AI_LOG (
  id SERIAL PRIMARY KEY,
  session_id INTEGER DEFAULT NULL,
  lesson_id INTEGER DEFAULT NULL,
  request_type VARCHAR(30) NOT NULL,
  model VARCHAR(100) DEFAULT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  neurons DOUBLE PRECISION DEFAULT 0,
  estimated_cost DOUBLE PRECISION DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_log_site_id ON TB_AI_LOG(site_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_request_type ON TB_AI_LOG(request_type);
CREATE INDEX IF NOT EXISTS idx_ai_log_session_id ON TB_AI_LOG(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_lesson_id ON TB_AI_LOG(lesson_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_created_at ON TB_AI_LOG(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_log_site_created ON TB_AI_LOG(site_id, created_at DESC);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_content_updated_at BEFORE UPDATE ON TB_CONTENT FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_session_updated_at BEFORE UPDATE ON TB_SESSION FOR EACH ROW EXECUTE FUNCTION update_updated_at();
