"""LLM cost accounting (acceptance 14.3: per-student cost vs the Rs 5 target).

Prices are USD per million tokens. Confirm them against the live pricing pages before a
client demo (https://claude.com/pricing, https://openai.com/api/pricing); override without a
code change via LLM_PRICING_JSON in .env, and set the exchange rate with USD_INR.

Claude cache pricing convention (claude-api skill, shared/prompt-caching.md + models.md):
cache writes cost 1.25x the base input price (5-minute TTL; a 1-hour TTL write costs 2x and is
NOT what cache_write_5m prices - the AI layer uses the default 5-minute TTL), cache reads ~0.1x
(0.05x on Claude Sonnet 5.5 / Opus 5.5). input_tokens is the uncached remainder only, so the
four token classes are billed independently.
"""
from __future__ import annotations

from ai_schemas import ModelUsage
from config import get_settings

# model-id prefix -> USD per MTok
PRICING_USD_PER_MTOK: dict[str, dict[str, float]] = {
    # Claude Sonnet 5.5: $2 / $10; 5-min cache write 1.25 x $2 = $2.50; cache read $0.10.
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_write_5m": 2.50, "cache_read": 0.10},
    # Claude Sonnet 5: same base price; cache read 0.1 x $2.
    "claude-sonnet-5": {"input": 2.00, "output": 10.00, "cache_write_5m": 2.50, "cache_read": 0.20},
    # Claude Opus 5.5: $4 / $20; cache write $5.00; cache read $0.20.
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_write_5m": 5.00, "cache_read": 0.20},
    # OpenAI (vision OCR when VISION_PROVIDER=openai). OpenAI caches prompts automatically: there is
    # no write premium, and cached input is billed at the "cache_read" rate. The AI layer reports
    # input_tokens = prompt_tokens - cached_tokens and cache_read_input_tokens = cached_tokens, so
    # the four token classes never double count. Longest prefix wins ("gpt-4o-mini" before "gpt-4o").
    "gpt-4o": {"input": 2.50, "output": 10.00, "cache_write_5m": 0.00, "cache_read": 1.25},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60, "cache_write_5m": 0.00, "cache_read": 0.075},
    "gpt-4.1": {"input": 2.00, "output": 8.00, "cache_write_5m": 0.00, "cache_read": 0.50},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60, "cache_write_5m": 0.00, "cache_read": 0.10},
}


def _price_table() -> dict[str, dict[str, float]]:
    table = {model: dict(prices) for model, prices in PRICING_USD_PER_MTOK.items()}
    for model, prices in get_settings().llm_pricing_overrides.items():
        table[model] = {**table.get(model, {"input": 0.0, "output": 0.0, "cache_write_5m": 0.0, "cache_read": 0.0}),
                        **prices}
    return table


def prices_for(model: str | None) -> dict[str, float] | None:
    """Longest-prefix match on the model id ('claude-sonnet-5-5-20261101' -> 'claude-sonnet-5-5')."""
    if not model:
        return None
    model = model.strip().lower()
    table = _price_table()
    for prefix in sorted(table, key=len, reverse=True):
        if model.startswith(prefix.lower()):
            return table[prefix]
    return None


def cost_usd(model: str | None, usage: ModelUsage) -> float | None:
    """USD cost of one call, or None when the model is not in the price table."""
    prices = prices_for(model)
    if prices is None:
        return None
    total = (
        usage.input_tokens * prices.get("input", 0.0)
        + usage.output_tokens * prices.get("output", 0.0)
        + usage.cache_creation_input_tokens * prices.get("cache_write_5m", 0.0)
        + usage.cache_read_input_tokens * prices.get("cache_read", 0.0)
    ) / 1_000_000
    return round(total, 6)


def to_inr(usd: float | None) -> float | None:
    if usd is None:
        return None
    return round(usd * get_settings().usd_inr, 4)


def format_inr(inr: float | None) -> str:
    """'Rs 1.84' for logs and messages ('cost unknown' when the model is not in the price table)."""
    if inr is None:
        return "cost unknown (model not in the price table)"
    return f"Rs {inr:.2f}"
