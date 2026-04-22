-- ============================================
-- AI Chatbot Database Schema (MySQL / Aurora)
-- ============================================
-- status: 1(정상), 0(중지), -1(삭제)

-- TB_CONTENT: 학습 콘텐츠
CREATE TABLE IF NOT EXISTS TB_CONTENT (
  id INT AUTO_INCREMENT PRIMARY KEY,
  content_nm VARCHAR(500) NOT NULL,
  filename VARCHAR(1000) NOT NULL,
  file_type VARCHAR(20) NOT NULL,
  file_size INT NOT NULL,
  content LONGTEXT,
  lesson_id INT DEFAULT NULL,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_content_created_at (created_at DESC),
  INDEX idx_content_status (status),
  INDEX idx_content_lesson_id (lesson_id),
  INDEX idx_content_site_id (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TB_SESSION: 채팅 세션
CREATE TABLE IF NOT EXISTS TB_SESSION (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT DEFAULT 0,
  course_id INT DEFAULT NULL,
  course_user_id INT DEFAULT NULL,
  lesson_id INT DEFAULT NULL,
  user_id INT DEFAULT NULL,
  session_nm VARCHAR(500) DEFAULT NULL,
  persona TEXT DEFAULT NULL,
  temperature DOUBLE DEFAULT 0.3,
  top_p DOUBLE DEFAULT 0.3,
  max_tokens INT DEFAULT 1024,
  summary_count INT DEFAULT 3,
  recommend_count INT DEFAULT 3,
  choice_count INT DEFAULT 3,
  ox_count INT DEFAULT 2,
  quiz_difficulty VARCHAR(20) DEFAULT 'normal',
  learning_goal TEXT DEFAULT NULL,
  learning_summary TEXT DEFAULT NULL,
  recommended_questions TEXT DEFAULT NULL,
  chat_content_ids TEXT DEFAULT NULL,
  welcome_message TEXT DEFAULT NULL,
  generation_status VARCHAR(20) DEFAULT NULL,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_session_status (status),
  INDEX idx_session_user (user_id),
  INDEX idx_session_parent_id (parent_id),
  INDEX idx_session_parent_course_user (parent_id, course_user_id),
  INDEX idx_session_site_id (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TB_MESSAGE: 채팅 메시지
CREATE TABLE IF NOT EXISTS TB_MESSAGE (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  user_id INT DEFAULT NULL,
  role VARCHAR(20) NOT NULL,
  content LONGTEXT NOT NULL,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_message_session (session_id, created_at),
  INDEX idx_message_status (status),
  INDEX idx_message_user (user_id),
  INDEX idx_message_site_id (site_id),
  CONSTRAINT fk_message_session FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TB_SESSION_CONTENT: 세션-콘텐츠 연결
CREATE TABLE IF NOT EXISTS TB_SESSION_CONTENT (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  content_id INT NOT NULL,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_session_content (session_id, content_id),
  INDEX idx_session_content_session (session_id),
  INDEX idx_session_content_content (content_id),
  INDEX idx_session_content_status (status),
  INDEX idx_session_content_site_id (site_id),
  CONSTRAINT fk_sc_session FOREIGN KEY (session_id) REFERENCES TB_SESSION(id) ON DELETE CASCADE,
  CONSTRAINT fk_sc_content FOREIGN KEY (content_id) REFERENCES TB_CONTENT(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TB_QUIZ: 퀴즈
CREATE TABLE IF NOT EXISTS TB_QUIZ (
  id INT AUTO_INCREMENT PRIMARY KEY,
  content_id INT NOT NULL DEFAULT 0,
  session_id INT DEFAULT NULL,
  quiz_type VARCHAR(10) NOT NULL,
  question TEXT NOT NULL,
  options TEXT DEFAULT NULL,
  answer VARCHAR(100) NOT NULL,
  explanation TEXT DEFAULT NULL,
  position INT NOT NULL,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_quiz_content (content_id, position),
  INDEX idx_quiz_session (session_id, position),
  INDEX idx_quiz_status (status),
  INDEX idx_quiz_site_id (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TB_AI_LOG: AI 사용 로그
CREATE TABLE IF NOT EXISTS TB_AI_LOG (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT DEFAULT NULL,
  lesson_id INT DEFAULT NULL,
  request_type VARCHAR(30) NOT NULL,
  model VARCHAR(100) DEFAULT NULL,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  neurons DOUBLE DEFAULT 0,
  estimated_cost DOUBLE DEFAULT 0,
  latency_ms INT DEFAULT 0,
  site_id INT NOT NULL DEFAULT 0,
  status INT DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_log_site_id (site_id),
  INDEX idx_ai_log_request_type (request_type),
  INDEX idx_ai_log_session_id (session_id),
  INDEX idx_ai_log_lesson_id (lesson_id),
  INDEX idx_ai_log_created_at (created_at DESC),
  INDEX idx_ai_log_site_created (site_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
