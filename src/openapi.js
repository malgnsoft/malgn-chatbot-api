export default {
  openapi: '3.0.0',
  info: {
    title: 'Malgn Chatbot API',
    version: '3.0.0',
    description: 'RAG 기반 AI 튜터 챗봇 API - Cloudflare Workers + Hono\n\n학습 자료를 등록하면 벡터 검색(Vectorize)을 통해 문서 기반 AI 응답을 생성합니다.\n부모-자식 세션 구조로 교수자/학습자 분리 운영을 지원합니다.\n\n## 멀티사이트\n모든 인증 필요 API에 `X-Site-Id` 헤더를 전달하여 사이트별 데이터를 격리합니다.\n미전달 시 기본값 `1`이 적용됩니다.\n\n## 처리 방식\n세션 생성(`/sessions/create-with-contents`)은 **동기 처리** 방식입니다. 학습 데이터/퀴즈 생성이 완료된 후 응답합니다 (10~30초 소요). 클라이언트는 HTTP 타임아웃을 60초 이상으로 설정하세요.'
  },
  servers: [
    {
      url: 'https://malgn-chatbot-api-cloud.malgnsoft.workers.dev',
      description: 'Production (cloud) — MySQL/Hyperdrive'
    },
    {
      url: 'https://malgn-chatbot-api-user1.malgnsoft.workers.dev',
      description: 'Production (user1) — MySQL/Hyperdrive (dev 공유)'
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
    { name: 'Quizzes', description: '퀴즈 관리 (4지선다, OX)' },
    { name: 'AI Logs', description: 'AI 호출 로그 조회' }
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
        description: '사용자 메시지를 받아 RAG 기반 AI 응답을 생성합니다.\n\n1. 세션의 콘텐츠 ID 조회 (parentId 처리)\n2. 메시지 임베딩 (768차원)\n3. Vectorize 유사 문서 검색\n4. 학습 데이터 + 퀴즈 컨텍스트 + 채팅 히스토리 조회\n5. 시스템 프롬프트 구축 후 LLM 호출\n6. 응답 저장 및 반환',
        tags: ['Chat'],
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
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
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
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
          { $ref: '#/components/parameters/SiteId' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '페이지 번호' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: '페이지당 개수' },
          { name: 'lessonId', in: 'query', schema: { type: 'integer' }, description: 'LMS 차시 ID 필터 (선택)' },
          { name: 'fileType', in: 'query', schema: { type: 'string', enum: ['pdf', 'txt', 'md', 'srt', 'vtt', 'text', 'link'] }, description: '파일 유형 필터 (선택)' }
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
        description: '텍스트, 링크, 파일(PDF/TXT/MD/SRT/VTT) 형식으로 콘텐츠를 등록합니다.\n\n처리 흐름:\n1. 텍스트 추출 → DB 저장\n2. 500자 단위 청크 분할 (100자 오버랩)\n3. 각 청크 임베딩 → Vectorize 저장\n\n※ 퀴즈는 세션 생성 시 설정에 맞게 자동 생성됩니다.',
        tags: ['Contents'],
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
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
                      lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
                    }
                  },
                  {
                    type: 'object',
                    required: ['type', 'title', 'url'],
                    properties: {
                      type: { type: 'string', enum: ['link'], description: '링크 타입' },
                      title: { type: 'string', description: '콘텐츠 제목' },
                      url: { type: 'string', format: 'uri', description: 'URL (HTTP/HTTPS)' },
                      lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
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
                  lessonId: { type: 'integer', description: 'LMS 차시 ID (선택)' }
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
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
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
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
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
          { $ref: '#/components/parameters/SiteId' },
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
          { $ref: '#/components/parameters/SiteId' },
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
                  lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID (선택)' }
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
          { $ref: '#/components/parameters/SiteId' },
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
          { $ref: '#/components/parameters/SiteId' },
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
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '콘텐츠 ID' }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  choiceCount: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: '4지선다 퀴즈 수' },
                  oxCount: { type: 'integer', minimum: 0, maximum: 10, default: 2, description: 'OX 퀴즈 수' },
                  count: { type: 'integer', minimum: 1, maximum: 20, description: '(하위호환) 총 퀴즈 수 (choice/ox 자동 분배)' },
                  difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], default: 'normal', description: '퀴즈 난이도' }
                }
              }
            }
          }
        },
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
    '/sessions/create-with-contents': {
      post: {
        summary: '콘텐츠 등록 + 세션 생성 일괄 처리',
        description: '콘텐츠(링크/텍스트) 등록 → 임베딩 생성 → 세션 생성 → 학습 메타데이터/퀴즈 자동 생성을 한 번의 API 호출로 처리합니다.\n\n**동기 처리**: 모든 생성이 완료된 후 201로 응답합니다 (10~30초 소요).\n\n**HTTP 타임아웃 설정**: 클라이언트에서 60초 이상의 타임아웃을 권장합니다.\n\n**callbackUrl (선택)**: 응답 후 동일한 결과를 별도로 POST 알림받고 싶을 때 사용. 전달하면 fire-and-forget으로 호출되며 응답 시점에 영향 없습니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contents'],
                properties: {
                  contents: {
                    type: 'array',
                    description: '등록할 콘텐츠 목록',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['link', 'link-subtitle', 'link-file', 'text'], description: '콘텐츠 타입 (link-subtitle: 자막, link-file: 파일, link: 일반 링크, text: 텍스트)' },
                        title: { type: 'string', description: '콘텐츠 제목' },
                        url: { type: 'string', description: 'URL (type=link일 때 필수, VTT/SRT/PDF/DOCX/PPTX/HTML 지원)' },
                        content: { type: 'string', description: '본문 텍스트 (type=text일 때 필수)' }
                      }
                    }
                  },
                  settings: {
                    type: 'object',
                    description: 'AI 설정',
                    properties: {
                      persona: { type: 'string' },
                      temperature: { type: 'number', default: 0.3 },
                      topP: { type: 'number', default: 0.3 },
                      maxTokens: { type: 'integer', default: 1024 },
                      summaryCount: { type: 'integer', default: 3 },
                      recommendCount: { type: 'integer', default: 3 },
                      choiceCount: { type: 'integer', default: 3, description: '4지선다 퀴즈 수' },
                      oxCount: { type: 'integer', default: 2, description: 'OX 퀴즈 수' },
                      quizDifficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], default: 'normal' }
                    }
                  },
                  sessionNm: { type: 'string', description: '세션 이름 (미지정 시 학습 데이터에서 자동 생성)' },
                  courseId: { type: 'integer', description: 'LMS 코스 ID' },
                  courseUserId: { type: 'integer', description: 'LMS 수강생 ID' },
                  lessonId: { type: 'integer', description: 'LMS 레슨(차시) ID' },
                  userId: { type: 'integer', description: '사용자 ID' },
                  chatContentIds: { type: 'array', items: { type: 'integer' }, description: '채팅 시 사용할 콘텐츠 ID 배열 (선택)' },
                  callbackUrl: { type: 'string', description: '응답과 동일한 결과를 추가로 POST할 콜백 URL (선택, fire-and-forget). 응답에는 영향 없음.' },
                  callbackData: { type: 'object', description: '콜백 시 그대로 반환할 임의 데이터 (LMS에서 요청 식별용)' }
                }
              },
              examples: {
                basic: {
                  summary: '기본 (동기 처리)',
                  value: {
                    contents: [
                      { type: 'link-subtitle', url: 'https://cdn.example.com/subtitle_ko.vtt', title: '위캔디오 자막' },
                      { type: 'link-file', url: 'https://cdn.example.com/lesson_material.pdf', title: '교안 PDF' }
                    ],
                    settings: { persona: 'AI 튜터 페르소나', temperature: 0.3, topP: 0.3, maxTokens: 1024, summaryCount: 3, recommendCount: 3, choiceCount: 3, oxCount: 2, quizDifficulty: 'normal' },
                    courseId: 123,
                    lessonId: 456,
                    sessionNm: '한국어 1A 4-1차시'
                  }
                },
                withCallback: {
                  summary: '콜백 알림 포함',
                  value: {
                    contents: [
                      { type: 'link-subtitle', url: 'https://cdn.example.com/subtitle_ko.vtt', title: '1과 자막' }
                    ],
                    settings: { choiceCount: 3, oxCount: 2, quizDifficulty: 'normal' },
                    lessonId: 2942,
                    callbackUrl: 'https://lms.example.com/api/chatbot/callback',
                    callbackData: { lessonId: 2942 }
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: '세션 생성 + 학습데이터/퀴즈 생성 완료',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'integer', description: '생성된 세션 ID' },
                        generationStatus: { type: 'string', enum: ['completed'], description: '생성 완료' },
                        title: { type: 'string' },
                        contents: {
                          type: 'array',
                          description: '등록된 콘텐츠 상세 목록',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'integer', description: '생성된 콘텐츠 ID' },
                              index: { type: 'integer', description: '요청 배열에서의 순서 (0부터)' },
                              title: { type: 'string', description: 'DB에 저장된 제목' },
                              inputName: { type: 'string', description: '요청 시 전달한 name/title' },
                              inputType: { type: 'string', description: '요청 시 전달한 type' },
                              inputUrl: { type: 'string', description: '요청 시 전달한 url (link 타입만)' },
                              type: { type: 'string', description: '저장된 파일 타입' }
                            }
                          }
                        },
                        settings: { type: 'object' },
                        learning: {
                          type: 'object',
                          properties: {
                            goal: { type: 'string' },
                            summary: { type: 'array', items: { type: 'string' } },
                            recommendedQuestions: { type: 'array' }
                          }
                        },
                        contentErrors: { type: 'array', description: '콘텐츠 등록 실패 목록 (일부 실패 시)' }
                      }
                    },
                    message: { type: 'string' }
                  }
                }
              }
            }
          },
          '400': { description: '콘텐츠 없음 또는 전체 등록 실패' },
          '401': { description: '인증 실패' },
          '500': { description: '서버 오류' }
        }
      }
    },
    '/sessions': {
      get: {
        summary: '세션 목록 조회',
        description: '기본은 부모 세션(parentId = 0)만 반환합니다.\n\n`include=children` 쿼리 추가 시: 부모 세션 다음에 그 부모에 속한 자식 세션들을 평면 배열로 함께 반환합니다. 응답의 각 세션 객체에 `parent_id` 필드가 포함되어 0=부모, >0=자식으로 구분합니다. 페이지네이션은 부모 세션 기준입니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '페이지 번호 (부모 세션 기준)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 }, description: '페이지당 개수 (부모 세션 기준)' },
          { name: 'generationStatus', in: 'query', schema: { type: 'string' }, description: '생성 상태 필터 (선택). 허용값: none, completed, failed (콤마 구분 다중 선택 가능)' },
          { name: 'include', in: 'query', schema: { type: 'string', enum: ['children'] }, description: 'children 지정 시 부모 세션에 속한 자식 세션들도 함께 반환' }
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
        description: '학습 콘텐츠를 선택하여 새 채팅 세션을 생성합니다.\n\n**부모 세션** (parentId = 0 또는 미지정):\n- contentIds 필수 (최소 1개)\n- 학습 목표, 요약, 추천 질문(Q&A 쌍) 자동 생성 (LLM 70B)\n- 학습 데이터 Vectorize 임베딩 저장\n- 퀴즈 자동 생성 (설정에 맞게, 난이도 반영)\n\n**자식 세션** (parentId > 0):\n- 부모의 콘텐츠/학습 데이터 공유\n- 동일 parent + courseUserId + lessonId 조합이면 기존 자식 세션 반환\n- 독립 채팅 히스토리 보유',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/SiteId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contentIds'],
                properties: {
                  contentIds: {
                    type: 'array',
                    items: { type: 'integer' },
                    minItems: 1,
                    description: '연결할 콘텐츠 ID 배열 (부모 세션 시 필수, 자식 세션 시 무시)',
                    example: [8, 9]
                  },
                  parentId: { type: 'integer', description: '부모 세션 ID (자식 세션 생성 시)', default: 0, example: 0 },
                  sessionNm: { type: 'string', description: '세션 이름 (미지정 시 학습 데이터에서 자동 생성)', nullable: true },
                  userId: { type: 'integer', description: '사용자 ID (선택)', nullable: true },
                  courseId: { type: 'integer', description: '코스 ID (LMS 연동, 선택)', nullable: true },
                  courseUserId: { type: 'integer', description: '코스 사용자 ID (LMS 연동, 선택)', nullable: true },
                  lessonId: { type: 'integer', description: '레슨 ID (LMS 연동, 선택)', nullable: true },
                  chatContentIds: { type: 'array', items: { type: 'integer' }, description: '채팅 시 사용할 콘텐츠 ID 배열 (선택)', nullable: true },
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
                      choiceCount: { type: 'integer', minimum: 0, maximum: 10, default: 3, description: '4지선다 퀴즈 수' },
                      oxCount: { type: 'integer', minimum: 0, maximum: 10, default: 2, description: 'OX 퀴즈 수' },
                      quizDifficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], default: 'normal', description: '퀴즈 난이도 (easy: 쉬움, normal: 보통, hard: 어려움)' }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '기존 자식 세션 반환 (동일 parent + courseUserId + lessonId 존재 시)',
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
          { $ref: '#/components/parameters/SiteId' },
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
        summary: '세션 업데이트',
        description: 'AI 설정, 세션 정보, 학습 메타데이터를 업데이트합니다.\n\n모든 필드는 선택적이며, 전달하지 않으면 기존값 유지, null 전달 시 초기화됩니다.\nlearningSummary, recommendedQuestions는 배열/객체 전달 시 자동 JSON 변환됩니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
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
                      sessionNm: { type: 'string', description: '세션 이름' },
                      persona: { type: 'string', description: 'AI 페르소나' },
                      temperature: { type: 'number', minimum: 0, maximum: 1, description: '온도 (0~1)' },
                      topP: { type: 'number', minimum: 0.1, maximum: 1, description: 'Top-P (0.1~1)' },
                      maxTokens: { type: 'integer', minimum: 256, maximum: 4096, description: '최대 토큰 수' },
                      summaryCount: { type: 'integer', minimum: 1, maximum: 10, description: '요약 개수' },
                      recommendCount: { type: 'integer', minimum: 1, maximum: 10, description: '추천 질문 개수' },
                      choiceCount: { type: 'integer', minimum: 0, maximum: 10, description: '4지선다 퀴즈 수' },
                      oxCount: { type: 'integer', minimum: 0, maximum: 10, description: 'OX 퀴즈 수' },
                      quizDifficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], description: '퀴즈 난이도' },
                      learningGoal: { type: 'string', nullable: true, description: '학습 목표 (null 전달 시 초기화)' },
                      learningSummary: {
                        description: '학습 요약 (문자열 또는 배열, null 전달 시 초기화)',
                        nullable: true,
                        oneOf: [
                          { type: 'string' },
                          { type: 'array', items: { type: 'string' } }
                        ]
                      },
                      recommendedQuestions: {
                        description: '추천 질문 (문자열 또는 Q&A 배열, null 전달 시 초기화)',
                        nullable: true,
                        oneOf: [
                          { type: 'string' },
                          {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                question: { type: 'string' },
                                answer: { type: 'string' }
                              }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '세션 업데이트 성공',
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
                        sessionNm: { type: 'string' },
                        settings: {
                          type: 'object',
                          properties: {
                            persona: { type: 'string' },
                            temperature: { type: 'number' },
                            topP: { type: 'number' },
                            maxTokens: { type: 'integer' },
                            summaryCount: { type: 'integer' },
                            recommendCount: { type: 'integer' },
                            choiceCount: { type: 'integer' },
                            oxCount: { type: 'integer' },
                            quizDifficulty: { type: 'string' }
                          }
                        },
                        learning: {
                          type: 'object',
                          properties: {
                            learningGoal: { type: 'string', nullable: true },
                            learningSummary: { type: 'string', nullable: true, description: 'JSON 문자열' },
                            recommendedQuestions: { type: 'string', nullable: true, description: 'JSON 문자열' }
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
          { $ref: '#/components/parameters/SiteId' },
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
    '/sessions/{id}/learning-goal': {
      put: {
        summary: '학습 목표 업데이트',
        description: '세션의 학습 목표를 업데이트합니다. null 전달 시 초기화.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['learningGoal'],
                properties: {
                  learningGoal: { type: 'string', nullable: true, description: '학습 목표', example: 'HTTP 프로토콜의 기본 개념을 이해한다.' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '업데이트 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { id: { type: 'integer' }, learningGoal: { type: 'string', nullable: true } } }, message: { type: 'string' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/learning-summary': {
      put: {
        summary: '학습 요약 업데이트',
        description: '세션의 학습 요약을 업데이트합니다. 배열 전달 시 자동 JSON 변환. null 전달 시 초기화.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['learningSummary'],
                properties: {
                  learningSummary: {
                    description: '학습 요약 (문자열 또는 배열)',
                    nullable: true,
                    oneOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } }
                    ],
                    example: ['HTTP는 클라이언트-서버 프로토콜이다.', 'REST는 HTTP 기반 아키텍처 스타일이다.']
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '업데이트 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { id: { type: 'integer' }, learningSummary: { type: 'string', nullable: true } } }, message: { type: 'string' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/recommended-questions': {
      put: {
        summary: '추천 질문 업데이트',
        description: '세션의 추천 질문을 업데이트합니다. Q&A 배열 전달 시 자동 JSON 변환. null 전달 시 초기화.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['recommendedQuestions'],
                properties: {
                  recommendedQuestions: {
                    description: '추천 질문 (문자열 또는 Q&A 배열)',
                    nullable: true,
                    oneOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } } } }
                    ],
                    example: [{ question: 'GET과 POST의 차이는?', answer: 'GET은 조회, POST는 생성에 사용됩니다.' }]
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '업데이트 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { id: { type: 'integer' }, recommendedQuestions: { type: 'string', nullable: true } } }, message: { type: 'string' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/messages': {
      delete: {
        summary: '세션 메시지 전체 삭제',
        description: '세션의 모든 채팅 메시지를 soft delete합니다. 세션 자체는 유지됩니다.',
        tags: ['Sessions'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
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
                    message: { type: 'string', example: '메시지가 초기화되었습니다.' }
                  }
                }
              }
            }
          },
          '401': { description: '인증 실패' },
          '404': { description: '세션 없음' }
        }
      }
    },
    '/sessions/{id}/quiz': {
      post: {
        summary: '세션 퀴즈 추가',
        description: '세션에 퀴즈를 직접 추가합니다. 콘텐츠 기반 자동 생성이 아닌 수동 추가.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quizType', 'question', 'answer'],
                properties: {
                  quizType: { type: 'string', enum: ['choice', 'ox'], description: '퀴즈 유형' },
                  question: { type: 'string', description: '문제' },
                  options: { type: 'array', items: { type: 'string' }, description: '4지선다 선택지 (choice 타입 필수, 4개)', example: ['HTTP', 'FTP', 'SMTP', 'SSH'] },
                  answer: { type: 'string', description: '정답 (choice: 1~4, ox: O/X)', example: '1' },
                  explanation: { type: 'string', description: '해설 (선택)' },
                  position: { type: 'integer', description: '순서 (선택, 미지정 시 마지막+1 자동 배정)' }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: '퀴즈 추가 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Quiz' }, message: { type: 'string' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      }
    },
    '/sessions/{id}/quiz/{quizId}': {
      get: {
        summary: '세션 퀴즈 단건 조회',
        description: '세션의 특정 퀴즈를 조회합니다. 자식 세션이면 부모의 퀴즈를 조회합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' },
          { name: 'quizId', in: 'path', required: true, schema: { type: 'integer' }, description: '퀴즈 ID' }
        ],
        responses: {
          '200': {
            description: '퀴즈 조회 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Quiz' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      put: {
        summary: '세션 퀴즈 수정',
        description: '세션에 직접 추가된 퀴즈를 수정합니다. 전달된 필드만 업데이트됩니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' },
          { name: 'quizId', in: 'path', required: true, schema: { type: 'integer' }, description: '퀴즈 ID' }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  quizType: { type: 'string', enum: ['choice', 'ox'], description: '퀴즈 유형' },
                  question: { type: 'string', description: '문제' },
                  options: { type: 'array', items: { type: 'string' }, description: '4지선다 선택지 (choice 타입, 4개)' },
                  answer: { type: 'string', description: '정답 (choice: 1~4, ox: O/X)' },
                  explanation: { type: 'string', nullable: true, description: '해설' },
                  position: { type: 'integer', description: '순서 (선택)' }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: '수정 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Quiz' }, message: { type: 'string' } } } } }
          },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '500': { $ref: '#/components/responses/InternalError' }
        }
      },
      delete: {
        summary: '세션 퀴즈 삭제',
        description: '세션에 직접 추가된 퀴즈를 삭제합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' },
          { name: 'quizId', in: 'path', required: true, schema: { type: 'integer' }, description: '퀴즈 ID' }
        ],
        responses: {
          '200': {
            description: '삭제 성공',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } }
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
        description: '세션에 연결된 콘텐츠 퀴즈 + 세션 직접 추가 퀴즈를 모두 조회합니다.\n자식 세션이면 부모의 콘텐츠 퀴즈를 조회합니다.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
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
          { $ref: '#/components/parameters/SiteId' },
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
    },
    '/ai-logs': {
      get: {
        summary: 'AI 사용 로그 목록',
        description: 'AI 모델 호출 로그를 조회합니다. 채팅, 학습데이터 생성, 퀴즈 생성, 임베딩 등 요청 유형별 필터링이 가능합니다.',
        tags: ['AI Logs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: '페이지 번호' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 }, description: '페이지당 개수' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['chat', 'learning', 'quiz_choice', 'quiz_ox', 'embedding'] }, description: '요청 유형 필터' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' }, description: '시작일 (YYYY-MM-DD)' },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' }, description: '종료일 (YYYY-MM-DD)' }
        ],
        responses: {
          '200': {
            description: 'AI 로그 목록',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        logs: { type: 'array', items: { type: 'object' } },
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
      }
    },
    '/ai-logs/summary': {
      get: {
        summary: 'AI 사용량 요약',
        description: '요청 유형별 AI 사용량을 집계하여 반환합니다.',
        tags: ['AI Logs'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date' }, description: '시작일 (YYYY-MM-DD)' },
          { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date' }, description: '종료일 (YYYY-MM-DD)' }
        ],
        responses: {
          '200': {
            description: '사용량 요약',
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
    '/sessions/{id}/quizzes/reorder': {
      put: {
        summary: '세션 퀴즈 순서 재정렬',
        description: '세션의 모든 퀴즈를 4지선다 → OX 순서로 자동 정렬하고 position을 순차 갱신합니다. Body 불필요.',
        tags: ['Quizzes'],
        security: [{ bearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/SiteId' },
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '세션 ID' }
        ],
        responses: {
          '200': {
            description: '순서 변경 성공',
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
                        reordered: { type: 'integer' }
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
    parameters: {
      SiteId: {
        name: 'X-Site-Id',
        in: 'header',
        required: false,
        schema: { type: 'integer', default: 1 },
        description: '멀티사이트 ID. 사이트별 데이터 격리에 사용됩니다. 미전달 시 기본값 1.'
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
          contentNm: { type: 'string', description: '콘텐츠 이름' },
          filename: { type: 'string', description: '파일명 또는 URL' },
          fileType: { type: 'string', enum: ['pdf', 'txt', 'md', 'srt', 'vtt', 'text', 'link'], description: '파일 유형' },
          fileSize: { type: 'integer', description: '파일 크기 (bytes)' },
          lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID' },
          siteId: { type: 'integer', description: '사이트 ID (멀티사이트)' },
          status: { type: 'integer', description: '상태 (1=활성, 0=비활성, -1=삭제)' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ContentDetail: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          contentNm: { type: 'string' },
          filename: { type: 'string' },
          fileType: { type: 'string' },
          fileSize: { type: 'integer' },
          content: { type: 'string', description: '추출된 텍스트 전문' },
          lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID' },
          siteId: { type: 'integer', description: '사이트 ID (멀티사이트)' },
          status: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      SessionSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string', description: '세션 제목 (AI 생성 또는 첫 메시지 기반)' },
          parent_id: { type: 'integer', description: '부모 세션 ID (0=부모 세션, >0=해당 ID의 자식 세션)', example: 0 },
          lessonId: { type: 'integer', nullable: true, description: 'LMS 차시 ID' },
          courseId: { type: 'integer', nullable: true, description: 'LMS 코스 ID' },
          courseUserId: { type: 'integer', nullable: true, description: 'LMS 수강생 ID (자식 세션에서만 의미)' },
          userId: { type: 'integer', nullable: true, description: '생성자 ID' },
          generationStatus: { type: 'string', enum: ['none', 'completed', 'failed'], description: '학습데이터/퀴즈 생성 상태 (부모 세션에만 해당)' },
          hasLearningData: { type: 'boolean', description: '학습 데이터(목표/요약/추천질문) 생성 여부 (부모 세션에만 해당)' },
          contentCount: { type: 'integer', description: '연결된 콘텐츠 수 (부모 세션에만 해당)' },
          childCount: { type: 'integer', description: '자식 세션(학습자) 수 (부모 세션에만 해당)' },
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
          userId: { type: 'integer', nullable: true, description: '사용자 ID' },
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
              choiceCount: { type: 'integer', description: '4지선다 퀴즈 수' },
              oxCount: { type: 'integer', description: 'OX 퀴즈 수' },
              quizDifficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], description: '퀴즈 난이도' }
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
              recommendedQuestions: {
                type: 'array',
                description: '추천 질문+답변 목록 (Q&A 쌍)',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string', description: '추천 질문' },
                    answer: { type: 'string', description: '답변 (콘텐츠 기반, 4-6문장)' }
                  }
                }
              }
            }
          },
          contents: {
            type: 'array',
            description: '연결된 콘텐츠 목록',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                contentNm: { type: 'string' }
              }
            }
          },
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' }, description: '채팅 메시지 목록' },
          messageCount: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          role: { type: 'string', enum: ['user', 'assistant'], description: '메시지 역할' },
          content: { type: 'string', description: '메시지 내용' },
          createdAt: { type: 'string', format: 'date-time' }
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
