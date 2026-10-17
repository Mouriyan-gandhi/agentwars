"""FastAPI entrypoint for the ParcelPilot ADK sidecar.

Exposes `/analyze` (the main A2A endpoint Next.js calls) and `/a2a/agents`
(the standard A2A discovery card — lists the agents + their skills so another
A2A client could consume this service directly).
"""

from __future__ import annotations

import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

import google.generativeai as genai

from orchestrator import analyze
from schemas import AnalyzeRequest, AnalyzeResponse


# Configure the Gemini client once from env.
_api_key = os.getenv("GEMINI_API_KEY")
if _api_key:
    genai.configure(api_key=_api_key)

_shared_token = os.getenv("AGENT_SERVICE_TOKEN", "")


app = FastAPI(title="ParcelPilot Agent Service", version="1.0")


def _require_token(authorization: str | None) -> None:
    if not _shared_token:
        return  # dev convenience: no token configured → open
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    if authorization.removeprefix("Bearer ").strip() != _shared_token:
        raise HTTPException(401, "invalid token")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "gemini_configured": "yes" if _api_key else "no"}


@app.get("/a2a/agents")
def a2a_card() -> JSONResponse:
    """A2A discovery card — describes the agents + skills this service hosts.
    Follows the shape of Google A2A's Agent Card spec closely enough that an
    A2A-aware client can route to us by capability.
    """
    return JSONResponse(
        {
            "name": "parcelpilot-brain",
            "version": "1.0",
            "protocol": "a2a",
            "capabilities": [
                "pii_masking",
                "incident_classification",
                "recovery_planning",
                "evaluation",
                "self_healing",
            ],
            "agents": [
                {"name": "pii_guardian", "role": "mask personal information before downstream agents"},
                {"name": "classifier",   "role": "classify incident type from masked text"},
                {"name": "planner",      "role": "choose recovery action from masked text"},
                {"name": "evaluator",    "role": "score planner output for truthfulness + hallucination"},
                {"name": "self_heal_loop", "role": "retry planner if evaluator verdict is retry"},
            ],
            "endpoints": {
                "analyze": {"method": "POST", "path": "/analyze"},
            },
        }
    )


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_endpoint(
    req: AnalyzeRequest,
    authorization: str | None = Header(default=None),
) -> AnalyzeResponse:
    _require_token(authorization)
    return analyze(req)
