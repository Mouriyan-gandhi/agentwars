"""Deterministic guardrails. No LLM, no third-party deps — importable from
anywhere (including unit tests) with pure-Python.

Two functions:
  injection_check(text)        — flag classic prompt-injection patterns
  leak_check(output, pii_map)  — scan a dict for real PII values; a hit is a
                                 hard guardrail failure independent of the
                                 LLM evaluator's opinion.
"""

from __future__ import annotations

import json
import re
from typing import Any


_INJECTION_PATTERNS = [
    r"ignore (all |previous |above )?instructions?",
    r"disregard (the )?(system|above|previous)",
    r"you are now",
    r"reveal (the|your) (system )?prompt",
    r"print the (pii|map|token)s?",
    r"<<[A-Z]+_\d+>>\s*=",
    r"act as (an? )?(admin|developer)",
]


def injection_check(text: str) -> dict[str, Any]:
    """Return `{flagged: bool, hits: [pattern, ...]}`."""
    if not text:
        return {"flagged": False, "hits": []}
    hits = [p for p in _INJECTION_PATTERNS if re.search(p, text, flags=re.IGNORECASE)]
    return {"flagged": bool(hits), "hits": hits}


def leak_check(output_payload: dict[str, Any] | None, pii_map: dict[str, str]) -> dict[str, Any]:
    """Scan `output_payload` for any real value from `pii_map`.

    A hit is a hard-fail: it means the Decider agent either hallucinated a
    real PII value or echoed one that leaked through masking. Values shorter
    than 4 characters are skipped to avoid matching initials ("SM", "AJ").
    """
    if not output_payload:
        return {"leaked": False, "hits": []}
    blob = json.dumps(output_payload, ensure_ascii=False)
    hits = []
    for tok, real in pii_map.items():
        if not real or len(real) < 4:
            continue
        if real in blob:
            hits.append({"token": tok, "value_preview": real[:3] + "***"})
    return {"leaked": bool(hits), "hits": hits}
