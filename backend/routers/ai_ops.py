"""[W2-1] LLM provider chain and Bloom detection (contract v3, API_CONTRACT.md):

- GET  /api/ops/llm-chain                 -> LlmChainStatus
- POST /api/ops/llm-chain/drill           (LlmDrillInput) -> LlmDrillResult
- POST /api/rubrics/{rubric_id}/bloom-levels (BloomDetectInput) -> BloomDetection
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()
