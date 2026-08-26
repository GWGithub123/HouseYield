#!/bin/bash

# Equifax OneView API Test Script

CLIENT_ID="w6GihRTS7SPEkll93AHb1ncEE9gQwkQn"
CLIENT_SECRET="tH0RVee8dY2aAdNb"
BASE_URL="https://api.uat.equifax.com"

echo "=== Step 1: Get OAuth Token ==="
TOKEN_RESPONSE=$(curl -s -X POST "${BASE_URL}/v2/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -d "grant_type=client_credentials" \
  -d "scope=https://api.equifax.com/business/oneview/consumer-credit/v1")

echo "Token Response: $TOKEN_RESPONSE"

ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to get access token"
  exit 1
fi

echo ""
echo "Access Token: ${ACCESS_TOKEN:0:50}..."
echo ""

echo "=== Step 2: Request Credit Report ==="

# Using the exact sample structure from Equifax docs
REQUEST_BODY='{
  "consumers": {
    "name": [
      {
        "identifier": "current",
        "firstName": "LJBKFJ",
        "lastName": "KHJGUFJM"
      }
    ],
    "socialNum": [
      {
        "identifier": "current",
        "number": "666123456"
      }
    ],
    "addresses": [
      {
        "identifier": "current",
        "houseNumber": "123",
        "streetName": "POIBHHFJD",
        "streetType": "ST",
        "city": "ATLANTA",
        "state": "GA",
        "zip": "30374"
      }
    ]
  },
  "customerReferenceIdentifier": "HOUSEYIELD-TEST-001",
  "customerConfiguration": {
    "equifaxUSConsumerCreditReport": {
      "memberNumber": "999RT00267",
      "securityCode": "@U1",
      "customerCode": "IAPI",
      "multipleReportIndicator": "1",
      "ECOAInquiryType": "Individual"
    }
  }
}'

echo "Request Body:"
echo "$REQUEST_BODY" | jq .
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/business/oneview/consumer-credit/v1/reports/credit-report" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo ""
echo "Response Body:"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
