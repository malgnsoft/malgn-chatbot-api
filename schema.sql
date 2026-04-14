-- ============================================
-- AI Chatbot Database Schema
-- ============================================
-- status: 1(정상), 0(중지), -1(삭제)

-- TB_CONTENT: 학습 콘텐츠
CREATE TABLE IF NOT EXISTS TB_CONTENT (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_nm TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  content TEXT,
  lesson_id INTEGER,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster listing by date
CREATE INDEX IF NOT EXISTS idx_content_created_at ON TB_CONTENT(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_status ON TB_CONTENT(status);
CREATE INDEX IF NOT EXISTS idx_content_lesson_id ON TB_CONTENT(lesson_id);
CREATE INDEX IF NOT EXISTS idx_content_site_id ON TB_CONTENT(site_id);

-- TB_SESSION: 채팅 세션
CREATE TABLE IF NOT EXISTS TB_SESSION (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER DEFAULT 0,
  course_id INTEGER,
  course_user_id INTEGER,
  lesson_id INTEGER,
  user_id INTEGER,
  session_nm TEXT,
  persona TEXT DEFAULT '당신은 친절하고 전문적인 AI 튜터입니다. 학생들이 이해하기 쉽게 설명하고, 질문에 정확하게 답변해 주세요.',
  temperature REAL DEFAULT 0.3,
  top_p REAL DEFAULT 0.3,
  max_tokens INTEGER DEFAULT 1024,
  summary_count INTEGER DEFAULT 3,
  recommend_count INTEGER DEFAULT 3,
  choice_count INTEGER DEFAULT 3,
  ox_count INTEGER DEFAULT 2,
  quiz_difficulty TEXT DEFAULT 'normal',
  learning_goal TEXT,
  learning_summary TEXT,
  recommended_questions TEXT,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for session
CREATE INDEX IF NOT EXISTS idx_session_status ON TB_SESSION(status);
CREATE INDEX IF NOT EXISTS idx_session_user ON TB_SESSION(user_id);
CREATE INDEX IF NOT EXISTS idx_session_parent_id ON TB_SESSION(parent_id);
CREATE INDEX IF NOT EXISTS idx_session_parent_course_user ON TB_SESSION(parent_id, course_user_id);
CREATE INDEX IF NOT EXISTS idx_session_site_id ON TB_SESSION(site_id);

-- TB_MESSAGE: 채팅 메시지
CREATE TABLE IF NOT EXISTS TB_MESSAGE (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE
);

-- Index for message lookup
CREATE INDEX IF NOT EXISTS idx_message_session ON TB_MESSAGE(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_status ON TB_MESSAGE(status);
CREATE INDEX IF NOT EXISTS idx_message_user ON TB_MESSAGE(user_id);
CREATE INDEX IF NOT EXISTS idx_message_site_id ON TB_MESSAGE(site_id);

-- TB_SESSION_CONTENT: 세션-콘텐츠 연결 (채팅방별 자료 범위 설정)
CREATE TABLE IF NOT EXISTS TB_SESSION_CONTENT (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  content_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE,
  FOREIGN KEY (content_id) REFERENCES TB_CONTENT(id) ON DELETE CASCADE,
  UNIQUE(session_id, content_id)
);

-- Index for session content lookup
CREATE INDEX IF NOT EXISTS idx_session_content_session ON TB_SESSION_CONTENT(session_id);
CREATE INDEX IF NOT EXISTS idx_session_content_content ON TB_SESSION_CONTENT(content_id);
CREATE INDEX IF NOT EXISTS idx_session_content_status ON TB_SESSION_CONTENT(status);
CREATE INDEX IF NOT EXISTS idx_session_content_site_id ON TB_SESSION_CONTENT(site_id);

-- TB_QUIZ: 퀴즈 (콘텐츠 기반 또는 세션 직접 추가)
-- quiz_type: 'choice' (4지선다), 'ox' (OX퀴즈)
-- content_id: 콘텐츠 기반 퀴즈 (자동 생성)
-- session_id: 세션 직접 추가 퀴즈 (수동 추가)
CREATE TABLE IF NOT EXISTS TB_QUIZ (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id INTEGER NOT NULL DEFAULT 0,
  session_id INTEGER,
  quiz_type TEXT NOT NULL CHECK (quiz_type IN ('choice', 'ox')),
  question TEXT NOT NULL,
  options TEXT,
  answer TEXT NOT NULL,
  explanation TEXT,
  position INTEGER NOT NULL,
  site_id INTEGER NOT NULL DEFAULT 0,
  status INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES TB_CONTENT(id) ON DELETE CASCADE
);

-- Index for quiz lookup
CREATE INDEX IF NOT EXISTS idx_quiz_content ON TB_QUIZ(content_id, position);
CREATE INDEX IF NOT EXISTS idx_quiz_session ON TB_QUIZ(session_id, position);
CREATE INDEX IF NOT EXISTS idx_quiz_status ON TB_QUIZ(status);
CREATE INDEX IF NOT EXISTS idx_quiz_site_id ON TB_QUIZ(site_id);

-- TB_AI_LOG: AI 사용 로그
-- request_type: 'chat', 'learning', 'learning_answer', 'quiz_choice', 'quiz_ox', 'embedding'
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

-- Index for AI log
CREATE INDEX IF NOT EXISTS idx_ai_log_site_id ON TB_AI_LOG(site_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_request_type ON TB_AI_LOG(request_type);
CREATE INDEX IF NOT EXISTS idx_ai_log_session_id ON TB_AI_LOG(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_log_created_at ON TB_AI_LOG(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_log_site_created ON TB_AI_LOG(site_id, created_at DESC);
