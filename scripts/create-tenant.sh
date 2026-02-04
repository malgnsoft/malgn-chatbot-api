#!/bin/bash

# ============================================
# 새 테넌트 생성 스크립트
# 사용법: ./scripts/create-tenant.sh <tenant_id>
# ============================================

set -e

TENANT_ID=$1

if [ -z "$TENANT_ID" ]; then
  echo "Usage: ./scripts/create-tenant.sh <tenant_id>"
  echo "Example: ./scripts/create-tenant.sh user2"
  exit 1
fi

echo "============================================"
echo "Creating tenant: $TENANT_ID"
echo "============================================"
echo ""

# 1. D1 Database 생성
echo "[1/4] Creating D1 Database..."
D1_OUTPUT=$(wrangler d1 create "malgn-chatbot-db-${TENANT_ID}" 2>&1)
D1_ID=$(echo "$D1_OUTPUT" | grep -oE 'database_id = "[^"]+"' | cut -d'"' -f2)
echo "  Database ID: $D1_ID"
echo ""

# 2. KV Namespace 생성
echo "[2/4] Creating KV Namespace..."
KV_OUTPUT=$(wrangler kv namespace create "malgn-chatbot-kv-${TENANT_ID}" 2>&1)
KV_ID=$(echo "$KV_OUTPUT" | grep -oE 'id = "[^"]+"' | cut -d'"' -f2)
echo "  KV Namespace ID: $KV_ID"
echo ""

# 3. R2 Bucket 생성
echo "[3/4] Creating R2 Bucket..."
wrangler r2 bucket create "malgn-chatbot-files-${TENANT_ID}"
echo ""

# 4. Vectorize Index 생성
echo "[4/4] Creating Vectorize Index..."
wrangler vectorize create "malgn-chatbot-vectors-${TENANT_ID}" --dimensions=768 --metric=cosine
echo ""

echo "============================================"
echo "Resources created successfully!"
echo "============================================"
echo ""
echo "Add the following to wrangler.toml:"
echo ""
echo "# ============================================"
echo "# Tenant: ${TENANT_ID}"
echo "# ============================================"
echo ""
echo "[env.${TENANT_ID}]"
echo "name = \"malgn-chatbot-api-${TENANT_ID}\""
echo "vars = { ENVIRONMENT = \"production\", TENANT_ID = \"${TENANT_ID}\" }"
echo ""
echo "[env.${TENANT_ID}.ai]"
echo "binding = \"AI\""
echo ""
echo "[[env.${TENANT_ID}.d1_databases]]"
echo "binding = \"DB\""
echo "database_name = \"malgn-chatbot-db-${TENANT_ID}\""
echo "database_id = \"${D1_ID}\""
echo ""
echo "[[env.${TENANT_ID}.kv_namespaces]]"
echo "binding = \"KV\""
echo "id = \"${KV_ID}\""
echo ""
echo "[[env.${TENANT_ID}.r2_buckets]]"
echo "binding = \"BUCKET\""
echo "bucket_name = \"malgn-chatbot-files-${TENANT_ID}\""
echo ""
echo "[[env.${TENANT_ID}.vectorize]]"
echo "binding = \"VECTORIZE\""
echo "index_name = \"malgn-chatbot-vectors-${TENANT_ID}\""
echo ""
echo "============================================"
echo "Next steps:"
echo "============================================"
echo ""
echo "1. Copy the above config to wrangler.toml"
echo ""
echo "2. Apply D1 schema:"
echo "   wrangler d1 execute malgn-chatbot-db-${TENANT_ID} --file=./schema.sql"
echo ""
echo "3. Set secrets:"
echo "   wrangler secret put OPENAI_API_KEY --env ${TENANT_ID}"
echo ""
echo "4. Deploy:"
echo "   wrangler deploy --env ${TENANT_ID}"
echo ""
