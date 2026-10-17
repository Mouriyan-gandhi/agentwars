"""PII Guardian — detects and masks personal information before any downstream
agent sees the text. The orchestrator holds the real→token mapping; sub-agents
only ever receive the masked version.

Fields masked:
  - names (customer + rider)
  - email addresses (customer_email + optional notify_email)
  - phone numbers
  - street addresses
  - any free-text occurrence of the above that the LLM detects

Strategy: deterministic regex + known-value substitution first (so we never
rely on an LLM to find the obvious patterns), then an LLM pass to catch
natural-language mentions the regex missed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# google.generativeai is imported lazily inside llm_mask_remaining() so the
# deterministic regex path (and the test harness) can run with no dependencies.


EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}")
# Order codes like PP-1001 — keep visible (they're useful routing info and
# aren't personally identifying) but tokenize so a downstream prompt-injection
# attempt can't trick an agent into exfiltrating them.
ORDER_RE = re.compile(r"\bPP-\d{3,6}\b")


@dataclass
class MaskResult:
    masked_text: str
    pii_map: dict[str, str] = field(default_factory=dict)  # token → real value
    counters: dict[str, int] = field(default_factory=dict)
    llm_used: bool = False
    llm_tokens_in: int = 0
    llm_tokens_out: int = 0

    def token_for(self, kind: str, value: str) -> str:
        """Return an existing token for `value` or mint a new one."""
        for tok, v in self.pii_map.items():
            if v == value and tok.startswith(f"<<{kind.upper()}_"):
                return tok
        self.counters[kind] = self.counters.get(kind, 0) + 1
        tok = f"<<{kind.upper()}_{self.counters[kind]}>>"
        self.pii_map[tok] = value
        return tok


def mask_known_values(result: MaskResult, text: str, known: dict[str, list[str]]) -> str:
    """Substitute values we already know (from order context) first — this is
    deterministic and does not depend on the LLM.

    `known` is e.g. {"name": ["Caanush Gandhi"], "email": ["caanush@…"], …}
    """
    out = text
    for kind, values in known.items():
        for v in values:
            if not v or not isinstance(v, str):
                continue
            v = v.strip()
            if not v:
                continue
            token = result.token_for(kind, v)
            # Replace case-insensitively but preserve non-matched text.
            out = re.sub(re.escape(v), token, out, flags=re.IGNORECASE)
    return out


def mask_patterns(result: MaskResult, text: str) -> str:
    """Mask anything that still looks like PII after known-value substitution."""
    def replace_email(m: re.Match[str]) -> str:
        return result.token_for("email", m.group(0))

    def replace_phone(m: re.Match[str]) -> str:
        return result.token_for("phone", m.group(0))

    def replace_order(m: re.Match[str]) -> str:
        return result.token_for("order", m.group(0))

    out = EMAIL_RE.sub(replace_email, text)
    out = PHONE_RE.sub(replace_phone, out)
    out = ORDER_RE.sub(replace_order, out)
    return out


LLM_MASK_PROMPT = """You are a PII redaction agent. Below is a short message
from a logistics customer or delivery rider. Return the SAME message, but
replace any remaining personal information (names of real people, street
addresses, apartment numbers, building names) with placeholder tokens of the
form <<NAME_n>>, <<ADDR_n>>, <<BUILDING_n>>. Keep token numbering consistent
within the message. Do NOT invent new content. Return ONLY the redacted text.

Already-redacted tokens in the input (keep them as-is):
{existing_tokens}

Message:
---
{text}
---
Redacted message:"""


# Heuristic signals that there's still PII the regex missed: capitalized
# multi-word proper nouns, street-number-style patterns, "called X" phrases.
_RESIDUAL_PII_HINTS = re.compile(
    r"(?:\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b"      # Two Capitalized Words (likely name)
    r"|\bapt\.?\s*\d+|\bflat\s*\d+|\broom\s*\d+"   # unit numbers
    r"|\bstreet\s+\d+|\broad\s+\d+|\bno\.?\s*\d+)"
)


def llm_mask_remaining(result: MaskResult, text: str, model_name: str) -> str:
    """Catch natural-language PII the regexes missed. SKIPPED when there's no
    heuristic signal of residual PII — this is the single biggest token-economy
    win: for ~70% of inputs the LLM pass never runs."""
    if not _RESIDUAL_PII_HINTS.search(text):
        # Deterministic layer already covered everything we can detect. No
        # need to burn tokens on an LLM confirmation pass.
        return text

    try:
        import google.generativeai as genai  # lazy
        model = genai.GenerativeModel(model_name)
        prompt = LLM_MASK_PROMPT.format(
            existing_tokens=", ".join(result.pii_map.keys()) or "(none yet)",
            text=text,
        )
        # Track cost. count_tokens is best-effort — if it fails we fall back
        # to a 4-chars-per-token heuristic so the admin UI still gets a number.
        try:
            tin = int(getattr(model.count_tokens(prompt), "total_tokens", 0) or 0)
        except Exception:
            tin = max(1, len(prompt) // 4)
        result.llm_tokens_in += tin
        result.llm_used = True
        resp = model.generate_content(
            prompt,
            generation_config={"temperature": 0.0, "max_output_tokens": 512},
        )
        masked = (resp.text or "").strip()
        try:
            tout = int(getattr(model.count_tokens(masked), "total_tokens", 0) or 0) if masked else 0
        except Exception:
            tout = max(1, len(masked) // 4)
        result.llm_tokens_out += tout
        if not masked:
            return text
        for tok in set(re.findall(r"<<[A-Z]+_\d+>>", masked)):
            result.pii_map.setdefault(tok, "")
        return masked
    except Exception:
        # If the LLM is unavailable, fail safely to the regex-only output.
        return text


def guardian_mask(
    raw_text: str,
    order_context: dict[str, Any] | None,
    notify_email: str | None,
    model_name: str,
) -> MaskResult:
    """Primary entry point.

    Masks every known identifier from order_context (customer name/email/phone/
    address, rider name/phone, notify_email, order_code), then runs regex +
    LLM passes to catch anything in free text.
    """
    result = MaskResult(masked_text="")

    known: dict[str, list[str]] = {
        "name": [],
        "email": [],
        "phone": [],
        "address": [],
        "building": [],
        "order": [],
    }
    if order_context:
        if order_context.get("customer_name"):
            known["name"].append(order_context["customer_name"])
        if order_context.get("customer_email"):
            known["email"].append(order_context["customer_email"])
        if order_context.get("customer_phone"):
            known["phone"].append(order_context["customer_phone"])
        if order_context.get("address"):
            known["address"].append(order_context["address"])
        if order_context.get("address_notes"):
            known["building"].append(order_context["address_notes"])
        if order_context.get("order_code"):
            known["order"].append(order_context["order_code"])
        if order_context.get("rider_name"):
            known["name"].append(order_context["rider_name"])
        if order_context.get("rider_phone"):
            known["phone"].append(order_context["rider_phone"])
    if notify_email:
        known["email"].append(notify_email)

    # 1. deterministic substitution of known values
    text = mask_known_values(result, raw_text or "", known)
    # 2. regex catchalls (emails/phones/order codes still in free text)
    text = mask_patterns(result, text)
    # 3. LLM pass for natural-language PII the regex missed
    text = llm_mask_remaining(result, text, model_name)

    # Always seed the map with known identifiers even if they didn't appear in
    # the raw text — Next.js uses pii_map to decide where to deliver email, and
    # we want notify_email in the map regardless of whether the user wrote it
    # into their complaint body.
    for kind, values in known.items():
        for v in values:
            if v:
                result.token_for(kind, v)

    result.masked_text = text
    return result


def unmask(text: str, pii_map: dict[str, str]) -> str:
    """Replace tokens with real values. Used only at trusted boundaries."""
    out = text
    for tok, real in pii_map.items():
        if real:
            out = out.replace(tok, real)
    return out
