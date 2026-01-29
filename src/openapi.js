export default {
  openapi: '3.0.0',
  info: {
    title: 'AI Chatbot API',
    version: '1.0.0',
    description: 'RAG 기반 AI 챗봇 API - Cloudflare Workers + Hono'
  },
  servers: [
    {
      url: 'https://malgn-chatbot-api.dotype.workers.dev',
      description: 'Production'
    },
    {
      url: 'http://localhost:8787',
      description: 'Development'
    }
  ],
  tags: [
    { name: 'General', description: '기본 엔드포인트' },
    { name: 'Chat', description: '채팅 API' },
    { name: 'Contents', description: '콘텐츠(학습 자료) 관리' },
    { name: 'Sessions', description: '채팅 세션 관리' },
    { name: 'Quizzes', description: '퀴즈 관리' }
  ],
  paths: {
    '/': {
      get: {
        summary: 'API 정보',
        tags: ['General'],
        responses: {
          '200': {
            description: 'API 정보 반환',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', example: 'AI Chatbot API' },
                    version: { type: 'string', example: '1.0.0' },
                    description: { type: 'string' },
                    environment: { type: 'string' },
                    endpoints: { type: 'object' },
                    timestamp: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
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
        summary: '채팅 메시지 전송',
        description: '사용자 메시지를 받아 RAG 기반 AI 응답을 생성합니다.',
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
            description: 'AI 응답',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatResponse' }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
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
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: '페이지당 개수' }
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
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '콘텐츠 등록',
        description: '텍스트, 링크, 파일(PDF/TXT/MD/SRT/VTT) 형식으로 콘텐츠를 등록합니다.',
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
                      content: { type: 'string', description: '텍스트 내용' }
                    }
                  },
                  {
                    type: 'object',
                    required: ['type', 'title', 'url'],
                    properties: {
                      type: { type: 'string', enum: ['link'], description: '링크 타입' },
                      title: { type: 'string', description: '콘텐츠 제목' },
                      url: { type: 'string', format: 'uri', description: 'URL' }
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
                  file: { type: 'string', format: 'binary', description: '파일 (PDF, TXT, MD, SRT, VTT / 최대 10MB)' },
                  title: { type: 'string', description: '콘텐츠 제목 (선택, 미입력시 파일명 사용)' }
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
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      put: {
        summary: '콘텐츠 수정',
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
                  content: { type: 'string', description: '내용 (선택)' }
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
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      delete: {
        summary: '콘텐츠 삭제',
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
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions': {
      get: {
        summary: '세션 목록 조회',
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
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '세션 생성',
        description: '학습 콘텐츠를 선택하여 새 채팅 세션을 생성합니다. 학습 목표, 요약, 추천 질문이 자동 생성됩니다.',
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
                  user_id: { type: 'string', description: '사용자 ID (선택)' },
                  content_ids: {
                    type: 'array',
                    items: { type: 'integer' },
                    minItems: 1,
                    description: '연결할 콘텐츠 ID 배열 (필수, 최소 1개)',
                    example: [8, 9]
                  },
                  settings: {
                    type: 'object',
                    description: 'AI 설정 (선택)',
                    properties: {
                      persona: { type: 'string' },
                      temperature: { type: 'number' },
                      topP: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
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
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}': {
      get: {
        summary: '세션 상세 조회',
        description: '세션 정보, 학습 데이터, 메시지 목록을 포함하여 반환합니다.',
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
                    data: { type: 'object' },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      delete: {
        summary: '세션 삭제',
        description: 'Soft delete - 세션, 메시지, 세션-콘텐츠 연결을 비활성화합니다.',
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
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/quizzes': {
      get: {
        summary: '세션 퀴즈 조회',
        description: '세션에 연결된 콘텐츠의 퀴즈를 조회합니다.',
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
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      post: {
        summary: '세션 퀴즈 재생성',
        description: '세션에 연결된 모든 콘텐츠의 퀴즈를 재생성합니다.',
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
                  count: { type: 'integer', minimum: 1, maximum: 20, description: '콘텐츠당 퀴즈 수 (기본: 세션 설정값)' }
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
        description: 'API Key를 입력하세요.'
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
              sources: { type: 'array', items: { type: 'object' }, description: '참조 소스' },
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
          filename: { type: 'string' },
          file_type: { type: 'string', enum: ['pdf', 'txt', 'md', 'srt', 'vtt', 'text', 'link'] },
          file_size: { type: 'integer' },
          status: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' }
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
          content: { type: 'string', description: '추출된 텍스트' },
          status: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      SessionSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          lastMessage: { type: 'string', nullable: true },
          messageCount: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      SessionDetail: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          userId: { type: 'string', nullable: true },
          title: { type: 'string' },
          settings: {
            type: 'object',
            properties: {
              persona: { type: 'string', nullable: true },
              temperature: { type: 'number' },
              topP: { type: 'number' },
              maxTokens: { type: 'integer' },
              summaryCount: { type: 'integer' },
              recommendCount: { type: 'integer' },
              quizCount: { type: 'integer' }
            }
          },
          learning: {
            type: 'object',
            properties: {
              goal: { type: 'string', nullable: true, description: '학습 목표' },
              summary: { description: '학습 요약', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
              recommendedQuestions: { type: 'array', items: { type: 'string' }, description: '추천 질문' }
            }
          },
          contents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                content_nm: { type: 'string' }
              }
            }
          },
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
          messageCount: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' }
        }
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' }
        }
      },
      Quiz: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          contentId: { type: 'integer' },
          quizType: { type: 'string', enum: ['choice', 'ox'], description: '퀴즈 유형' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
            nullable: true,
            description: '4지선다 선택지 (OX 퀴즈는 null)'
          },
          answer: { type: 'string', description: '정답 (choice: 1~4, ox: O/X)' },
          explanation: { type: 'string', description: '해설' },
          position: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' }
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
        description: '인증 실패',
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
