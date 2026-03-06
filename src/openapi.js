export default {
  openapi: '3.0.0',
  info: {
    title: 'Malgn Chatbot API',
    version: '2.0.0',
    description: 'RAG 기반 AI 튜터 챗봇 API - Cloudflare Workers + Hono\n\n학습 자료를 등록하면 벡터 검색(Vectorize)을 통해 문서 기반 AI 응답을 생성합니다.\n부모-자식 세션 구조로 교수자/학습자 분리 운영을 지원합니다.'
  },
  servers: [
    {
      url: 'https://malgn-chatbot-api.dotype.workers.dev',
      description: 'Production (default/user1)'
    },
    {
      url: 'https://malgn-chatbot-api-user2.dotype.workers.dev',
      description: 'Production (user2)'
    },
    {
      url: 'http://localhost:8787',
      description: 'Development'
    }
  ],
  tags: [
    { name: 'General', description: '기본 엔드포인트' },
    { name: 'Chat', description: '채팅 API (RAG 기반 질의응답)' },
    { name: 'Contents', description: '콘텐츠(학습 자료) 관리' },
    { name: 'Sessions', description: '채팅 세션 관리 (부모/자식 세션)' },
    { name: 'Quizzes', description: '퀴즈 관리 (4지선다, OX)' }
  ],
  paths: {
    '/': {
      get: {
        summary: 'API 문서 리다이렉트',
        description: 'Swagger UI 문서 페이지(/docs)로 리다이렉트합니다.',
        tags: ['General'],
        responses: {
          '302': {
            description: '/docs로 리다이렉트'
          }
        }
      }
    },
    '/health': {
      get: {
        summary: '서버 상태 확인',
        tags: ['General'],
        responses: {
          '200': {
            description: '서버 정상',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    timestamp: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/chat': {
      post: {
        summary: '채팅 메시지 전송 (동기)',
        description: '사용자 메시지를 받아 RAG 기반 AI 응답을 생성합니다.\n\n1. 세션의 콘텐츠 ID 조회 (parent_id 처리)\n2. 메시지 임베딩 (768차원)\n3. Vectorize 유사 문서 검색\n4. 학습 데이터 + 퀴즈 컨텍스트 + 채팅 히스토리 조회\n5. 시스템 프롬프트 구축 후 LLM 호출\n6. 응답 저장 및 반환',
        tags: ['Chat'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  message: { type: 'string', description: '사용자 메시지 (최대 10000자)', example: '이 내용에서 핵심 개념은 무엇인가요?' },
                  sessionId: { type: 'integer', description: '세션 ID', example: 1 },
                  settings: {
                    type: 'object',
                    description: 'AI 설정 (선택, 세션 설정 오버라이드)',
                    properties: {
                      persona: { type: 'string', description: 'AI 페르소나 (시스템 프롬프트)' },
                      temperature: { type: 'number', minimum: 0, maximum: 1, description: '창의성 (0~1)' },
                      topP: { type: 'number', minimum: 0.1, maximum: 1, description: '다양성 (0.1~1)' },
                      maxTokens: { type: 'integer', minimum: 256, maximum: 4096, description: '최대 토큰 수' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'AI 응답',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/chat/stream': {
      post: {
        summary: '채팅 메시지 전송 (SSE 스트리밍)',
        description: 'SSE(Server-Sent Events) 방식으로 AI 응답을 실시간 스트리밍합니다.\n\n이벤트 타입:\n- `token`: 부분 응답 토큰 `{ response: "..." }`\n- `done`: 완료 `{ sources: [...], sessionId: 1 }`\n- `error`: 오류 `{ message: "..." }`',
        tags: ['Chat'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  message: { type: 'string', description: '사용자 메시지 (최대 10000자)', example: 'Promise란 무엇인가요?' },
                  sessionId: { type: 'integer', description: '세션 ID', example: 1 },
                  settings: {
                    type: 'object',
                    description: 'AI 설정 (선택)',
                    properties: {
                      persona: { type: 'string' },
                      temperature: { type: 'number', minimum: 0, maximum: 1 },
                      topP: { type: 'number', minimum: 0.1, maximum: 1 },
                      maxTokens: { type: 'integer', minimum: 256, maximum: 4096 }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'SSE 스트림',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE 이벤트 스트림 (token, done, error)'
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/contents': {
      get: {
        summary: '콘텐츠 목록 조회',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '페이지 번호' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: '페이지당 개수' },
          { name: 'lesson_id', in: 'query', schema: { type: 'integer' }, description: 'LMS 차시 ID 필터 (선택)' }
        ],
        responses: {
          '200': {
            description: '콘텐츠 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        contents: { type: 'array', items: { $ref: '#/components/schemas/ContentSummary' } },
                        pagination: { $ref: '#/components/schemas/Pagination' }
                      }
                    }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '콘텐츠 등록',
        description: '텍스트, 링크, 파일(PDF/TXT/MD/SRT/VTT) 형식으로 콘텐츠를 등록합니다.\n\n처리 흐름:\n1. 텍스트 추출 → DB 저장\n2. 500자 단위 청크 분할 (100자 오버랩)\n3. 각 청크 임베딩 → Vectorize 저장\n4. (백그라운드) 퀴즈 자동 생성',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['type', 'title', 'content'],
                    properties: {
                      type: { type: 'string', enum: ['text'], description: '텍스트 타입' },
                      title: { type: 'string', description: '콘텐츠 제목' },
                      content: { type: 'string', description: '텍스트 내용 (최소 50자)' },
                      lesson_id: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
                    }
                  },
                  {
                    type: 'object',
                    required: ['type', 'title', 'url'],
                    properties: {
                      type: { type: 'string', enum: ['link'], description: '링크 타입' },
                      title: { type: 'string', description: '콘텐츠 제목' },
                      url: { type: 'string', format: 'uri', description: 'URL (HTTP/HTTPS)' },
                      lesson_id: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
                    }
                  }
                ]
              }
            },
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary', description: '파일 (PDF≤10MB, TXT/MD/SRT/VTT≤5MB)' },
                  title: { type: 'string', description: '콘텐츠 제목 (선택, 미입력시 파일명 사용)' },
                  lesson_id: { type: 'integer', description: 'LMS 차시 ID (선택)' }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: '콘텐츠 등록 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: { $ref: '#/components/schemas/ContentDetail' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '413': { description: '파일 크기 초과' },
          '415': { description: '지원하지 않는 파일 형식' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/contents/regenerate-all-quizzes': {
      post: {
        summary: '모든 콘텐츠 퀴즈 재생성',
        description: '퀴즈가 없는 콘텐츠에 대해 퀴즈를 일괄 생성합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: '퀴즈 재생성 결과',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer', description: '대상 콘텐츠 수' },
                        generated: { type: 'integer', description: '성공 수' },
                        skipped: { type: 'integer', description: '스킵 수' },
                        message: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/contents/reembed': {
      post: {
        summary: '모든 콘텐츠 재임베딩',
        description: 'Vectorize 인덱스 재생성 후 모든 콘텐츠를 재임베딩합니다.',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: '재임베딩 결과',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'object' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/contents/{id}': {
      get: {
        summary: '콘텐츠 상세 조회',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        responses: {
          '200': {
            description: '콘텐츠 상세',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: '#/components/schemas/ContentDetail' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      put: {
        summary: '콘텐츠 수정',
        description: '콘텐츠 제목과 내용을 수정합니다. 내용 변경 시 재임베딩이 수행됩니다.',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', description: '제목' },
                  content: { type: 'string', description: '내용 (선택, 변경 시 재임베딩)' },
                  lesson_id: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '수정 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: { $ref: '#/components/schemas/ContentDetail' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      delete: {
        summary: '콘텐츠 삭제',
        description: 'Soft delete (status = -1). Vectorize에서 청크 벡터도 삭제됩니다.',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        responses: {
          '200': {
            description: '삭제 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/contents/{id}/quizzes': {
      get: {
        summary: '콘텐츠 퀴즈 조회',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        responses: {
          '200': {
            description: '퀴즈 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        contentId: { type: 'integer' },
                        quizCount: { type: 'integer' },
                        quizzes: { type: 'array', items: { $ref: '#/components/schemas/Quiz' } }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '콘텐츠 퀴즈 재생성',
        description: '특정 콘텐츠의 퀴즈를 삭제하고 새로 생성합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        responses: {
          '200': {
            description: '퀴즈 재생성 결과',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        contentId: { type: 'integer' },
                        quizCount: { type: 'integer' },
                        quizzes: { type: 'array', items: { $ref: '#/components/schemas/Quiz' } }
                      }
                    },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions': {
      get: {
        summary: '세션 목록 조회',
        description: '부모 세션(parent_id = 0)만 반환합니다. 자식 세션은 포함되지 않습니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '페이지 번호' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 }, description: '페이지당 개수' }
        ],
        responses: {
          '200': {
            description: '세션 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        sessions: { type: 'array', items: { $ref: '#/components/schemas/SessionSummary' } },
                        pagination: { $ref: '#/components/schemas/Pagination' }
                      }
                    }
                  }
                }
              }
            }
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '세션 생성',
        description: '학습 콘텐츠를 선택하여 새 채팅 세션을 생성합니다.\n\n**부모 세션** (parent_id = 0 또는 미지정):\n- content_ids 필수 (최소 1개)\n- 학습 목표, 요약, 추천 질문 자동 생성 (LLM 70B)\n- 학습 데이터 Vectorize 임베딩 저장\n\n**자식 세션** (parent_id > 0):\n- 부모의 콘텐츠/학습 데이터 공유\n- 동일 parent + course_user_id 조합이면 기존 자식 세션 반환\n- 독립 채팅 히스토리 보유',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content_ids'],
                properties: {
                  content_ids: {
                    type: 'array',
                    items: { type: 'integer' },
                    minItems: 1,
                    description: '연결할 콘텐츠 ID 배열 (부모 세션 시 필수, 자식 세션 시 무시)',
                    example: [8, 9]
                  },
                  parent_id: { type: 'integer', description: '부모 세션 ID (자식 세션 생성 시)', default: 0, example: 0 },
                  user_id: { type: 'string', description: '사용자 ID (선택)', nullable: true },
                  course_id: { type: 'integer', description: '코스 ID (LMS 연동, 선택)', nullable: true },
                  course_user_id: { type: 'integer', description: '코스 사용자 ID (LMS 연동, 선택)', nullable: true },
                  lesson_id: { type: 'integer', description: '레슨 ID (LMS 연동, 선택)', nullable: true },
                  settings: {
                    type: 'object',
                    description: 'AI 설정 (선택)',
                    properties: {
                      persona: { type: 'string', description: 'AI 페르소나' },
                      temperature: { type: 'number', minimum: 0, maximum: 1 },
                      topP: { type: 'number', minimum: 0.1, maximum: 1 },
                      maxTokens: { type: 'integer', minimum: 256, maximum: 4096 },
                      summaryCount: { type: 'integer', minimum: 1, maximum: 10, description: '요약 개수' },
                      recommendCount: { type: 'integer', minimum: 1, maximum: 10, description: '추천 질문 개수' },
                      quizCount: { type: 'integer', minimum: 1, maximum: 20, description: '퀴즈 개수' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '기존 자식 세션 반환 (동일 parent + course_user_id 존재 시)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: { $ref: '#/components/schemas/SessionDetail' }
                  }
                }
              }
            }
          },
          '201': {
            description: '세션 생성 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: { $ref: '#/components/schemas/SessionDetail' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: '부모 세션을 찾을 수 없음 (자식 세션 생성 시)' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}': {
      get: {
        summary: '세션 상세 조회',
        description: '세션 정보, 학습 데이터, 메시지 목록을 포함하여 반환합니다.\n자식 세션이면 부모의 학습 데이터와 콘텐츠 목록을 사용합니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        responses: {
          '200': {
            description: '세션 상세',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: '#/components/schemas/SessionDetail' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      put: {
        summary: '세션 AI 설정 업데이트',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['settings'],
                properties: {
                  settings: {
                    type: 'object',
                    properties: {
                      persona: { type: 'string', description: 'AI 페르소나' },
                      temperature: { type: 'number', minimum: 0, maximum: 1, description: '온도 (0~1)' },
                      topP: { type: 'number', minimum: 0.1, maximum: 1, description: 'Top-P (0.1~1)' },
                      maxTokens: { type: 'integer', minimum: 256, maximum: 4096, description: '최대 토큰 수' },
                      summaryCount: { type: 'integer', minimum: 1, maximum: 10, description: '요약 개수' },
                      recommendCount: { type: 'integer', minimum: 1, maximum: 10, description: '추천 질문 개수' },
                      quizCount: { type: 'integer', minimum: 1, maximum: 20, description: '퀴즈 개수' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '설정 업데이트 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer' },
                        settings: {
                          type: 'object',
                          properties: {
                            persona: { type: 'string' },
                            temperature: { type: 'number' },
                            topP: { type: 'number' },
                            maxTokens: { type: 'integer' },
                            summaryCount: { type: 'integer' },
                            recommendCount: { type: 'integer' },
                            quizCount: { type: 'integer' }
                          }
                        }
                      }
                    },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      delete: {
        summary: '세션 삭제',
        description: 'Soft delete (status = -1).\n- 메시지, 세션-콘텐츠 연결 비활성화\n- Vectorize에서 학습 임베딩 삭제\n- 부모 세션 삭제 시 자식 세션도 연쇄 삭제',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        responses: {
          '200': {
            description: '삭제 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/quizzes': {
      get: {
        summary: '세션 퀴즈 조회',
        description: '세션에 연결된 콘텐츠의 퀴즈를 조회합니다.\n자식 세션이면 부모의 콘텐츠 퀴즈를 조회합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        responses: {
          '200': {
            description: '퀴즈 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'integer' },
                        quizzes: { type: 'array', items: { $ref: '#/components/schemas/Quiz' } },
                        total: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '세션 퀴즈 재생성',
        description: '세션에 연결된 모든 콘텐츠의 퀴즈를 재생성합니다.\n자식 세션이면 부모의 콘텐츠 퀴즈를 재생성합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  choiceCount: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: '콘텐츠당 4지선다 퀴즈 수' },
                  oxCount: { type: 'integer', minimum: 0, maximum: 10, default: 2, description: '콘텐츠당 OX 퀴즈 수' },
                  count: { type: 'integer', minimum: 1, maximum: 20, description: '(하위호환) 콘텐츠당 총 퀴즈 수 (choice/ox 자동 분배)' }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: '퀴즈 재생성 성공',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'integer' },
                        quizzes: { type: 'array', items: { $ref: '#/components/schemas/Quiz' } },
                        total: { type: 'integer' }
                      }
                    },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API Key를 Bearer 토큰으로 입력하세요.'
      }
    },
    schemas: {
      ChatResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              response: { type: 'string', description: 'AI 응답 메시지' },
              sources: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    contentId: { type: 'integer' },
                    contentTitle: { type: 'string' },
                    score: { type: 'number', description: '유사도 점수' }
                  }
                },
                description: '참조 소스 목록'
              },
              sessionId: { type: 'integer' }
            }
          }
        }
      },
      ContentSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          content_nm: { type: 'string', description: '콘텐츠 이름' },
          filename: { type: 'string', description: '파일명 또는 URL' },
          file_type: { type: 'string', enum: ['pdf', 'txt', 'md', 'srt', 'vtt', 'text', 'link'], description: '파일 유형' },
          file_size: { type: 'integer', description: '파일 크기 (bytes)' },
          lesson_id: { type: 'integer', nullable: true, description: 'LMS 차시 ID' },
          status: { type: 'integer', description: '상태 (1=활성, 0=비활성, -1=삭제)' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      ContentDetail: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          content_nm: { type: 'string' },
          filename: { type: 'string' },
          file_type: { type: 'string' },
          file_size: { type: 'integer' },
          content: { type: 'string', description: '추출된 텍스트 전문' },
          lesson_id: { type: 'integer', nullable: true, description: 'LMS 차시 ID' },
          status: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      SessionSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string', description: '세션 제목 (AI 생성 또는 첫 메시지 기반)' },
          lastMessage: { type: 'string', nullable: true, description: '마지막 메시지 미리보기 (50자)' },
          messageCount: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      SessionDetail: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          parentId: { type: 'integer', description: '부모 세션 ID (0이면 부모 세션)', example: 0 },
          userId: { type: 'string', nullable: true },
          title: { type: 'string', description: '세션 제목' },
          settings: {
            type: 'object',
            properties: {
              persona: { type: 'string', nullable: true, description: 'AI 페르소나' },
              temperature: { type: 'number', description: '온도 (0~1)' },
              topP: { type: 'number', description: 'Top-P (0.1~1)' },
              maxTokens: { type: 'integer', description: '최대 토큰 수' },
              summaryCount: { type: 'integer', description: '요약 개수' },
              recommendCount: { type: 'integer', description: '추천 질문 개수' },
              quizCount: { type: 'integer', description: '퀴즈 개수' }
            }
          },
          learning: {
            type: 'object',
            description: '학습 메타데이터 (자식 세션이면 부모의 데이터)',
            properties: {
              goal: { type: 'string', nullable: true, description: '학습 목표' },
              summary: {
                description: '학습 핵심 요약 (배열 또는 문자열)',
                oneOf: [
                  { type: 'string' },
                  { type: 'array', items: { type: 'string' } }
                ],
                nullable: true
              },
              recommendedQuestions: { type: 'array', items: { type: 'string' }, description: '추천 질문 목록' }
            }
          },
          contents: {
            type: 'array',
            description: '연결된 콘텐츠 목록',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                content_nm: { type: 'string' }
              }
            }
          },
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' }, description: '채팅 메시지 목록' },
          messageCount: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          role: { type: 'string', enum: ['user', 'assistant'], description: '메시지 역할' },
          content: { type: 'string', description: '메시지 내용' },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      Quiz: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          contentId: { type: 'integer', description: '소속 콘텐츠 ID' },
          quizType: { type: 'string', enum: ['choice', 'ox'], description: '퀴즈 유형 (choice: 4지선다, ox: OX)' },
          question: { type: 'string', description: '문제 (choice: 질문문, ox: 진술문)' },
          options: {
            type: 'array',
            items: { type: 'string' },
            nullable: true,
            description: '4지선다 선택지 (OX 퀴즈는 null)'
          },
          answer: { type: 'string', description: '정답 (choice: 1~4, ox: O/X)' },
          explanation: { type: 'string', description: '해설' },
          position: { type: 'integer', description: '문제 순서 (1부터)' },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', description: '현재 페이지' },
          limit: { type: 'integer', description: '페이지당 개수' },
          total: { type: 'integer', description: '전체 항목 수' },
          totalPages: { type: 'integer', description: '전체 페이지 수' }
        }
      }
    },
    responses: {
      ValidationError: {
        description: '입력 검증 실패',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', example: 'VALIDATION_ERROR' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      NotFound: {
        description: '리소스를 찾을 수 없음',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', example: 'NOT_FOUND' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      Unauthorized: {
        description: '인증 실패 (API Key 없음 또는 잘못됨)',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', example: 'UNAUTHORIZED' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      InternalError: {
        description: '서버 내부 오류',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                success: { type: 'boolean', example: false },
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', example: 'INTERNAL_ERROR' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
