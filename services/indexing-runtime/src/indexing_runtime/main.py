"""Indexing Runtime — FastAPI server + CLI."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import click
import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from observability import bind_trace_id, configure_logging
from pydantic import BaseModel

from indexing_runtime.embedders import (
    OLLAMA_ENDPOINT,
    is_embedding_capable,
    list_ollama_models,
)
from indexing_runtime.errors import ErrorCode, error_envelope, status_for
from indexing_runtime.pipeline import run_pipeline
from indexing_runtime.settings import EMBED_MODEL

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn.
configure_logging("indexing-runtime")
_logger = logging.getLogger("indexing_runtime")

app = FastAPI(title="Indexing Runtime", version="0.1.0")

# Repo-root-relative default, mirroring the same pattern already used by
# sibling services for the identical value (`distribution_service.config
# .Settings.index_base`, `portal_api.config.Settings.index_base`) — this
# module used to hardcode this developer's absolute machine path instead,
# which broke on any other machine (e.g. Windows) unless INDEX_BASE was set.
# `services/indexing-runtime/src/indexing_runtime/main.py` -> parents:
# indexing_runtime(1) -> src(2) -> indexing-runtime(3) -> services(4) ->
# enterprise-ai-asset-hub(5, repo root). See open-decisions.md D-073.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
_DEFAULT_INDEX_BASE = str(_REPO_ROOT / "data" / "indexes")
INDEX_BASE = os.environ.get("INDEX_BASE", _DEFAULT_INDEX_BASE)


class IndexJobRequest(BaseModel):
    version_id: str
    storage_path: str
    job_id: str
    embed_model: str = EMBED_MODEL
    index_base: str | None = None
    # Additive/optional (D-052-style compromise): portal-api's asset-upload
    # endpoint knows its own request trace_id and now passes it through
    # (see `portal_api.routers.assets._trigger_indexing`); older/direct
    # callers that omit it simply get a fresh id, same as before this field
    # existed.
    trace_id: str | None = None
    # Additive/optional (D-053): a possibly-partial Indexing Profile dict
    # (packages/schemas/profiles/indexing-profile.schema.json subset) — see
    # indexing_runtime.profile.resolve_profile. Omitted by every caller
    # today, which keeps the previous parent_child-at-default-sizes behavior.
    profile: dict | None = None
    # Additive/optional (D-062, §2.7/§3.8): the Knowledge asset manifest's
    # raw `classification` value. portal-api's `_trigger_indexing` passes
    # `manifest_dict.get("classification")` (may be None), not the
    # already-defaulted `Asset.classification` DB column — see
    # pipeline.run_pipeline's docstring. Omitted/unrecognized -> stamped as
    # Classification.UNKNOWN, never guessed as a real level.
    classification: str | None = None


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "version": "0.1.0"})


@app.get("/indexing/v1/models")
async def list_embedding_models() -> JSONResponse:
    """Model discovery for portal-api's P15 admin screen
    (open-decisions.md D-075 follow-up) — CLAUDE.md: "Portal API는 모델을
    직접 호출하지 않는다", so indexing-runtime (the service that owns the
    embedding relationship, D-075) is what actually talks to Ollama here;
    portal-api's `routers.admin` calls this endpoint over HTTP.

    Ollama unreachable is reported as a clear `MODEL_UNAVAILABLE` error, NOT
    a 500 and NOT an empty `models: []` (which would be indistinguishable
    from "Ollama is up with zero models installed", a real and different
    state a caller must be able to tell apart from "couldn't ask at all")."""
    import uuid

    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)

    try:
        raw_models = await list_ollama_models()
    except httpx.HTTPError as exc:
        _logger.warning("indexing.models.ollama_unavailable error=%s", exc)
        return JSONResponse(
            status_code=status_for(ErrorCode.MODEL_UNAVAILABLE),
            content=error_envelope(
                ErrorCode.MODEL_UNAVAILABLE,
                "Ollama에 연결할 수 없어 사용 가능한 모델 목록을 가져올 수 없습니다.",
                trace_id,
            ),
        )

    models = [
        {
            "name": name,
            "embedding_capable": is_embedding_capable(m),
            "size": m.get("size"),
            "modified_at": m.get("modified_at"),
        }
        for m in raw_models
        if (name := (m.get("name") or m.get("model")))
    ]
    return JSONResponse({
        "models": models,
        "default_embed_model": EMBED_MODEL,
        "source": f"{OLLAMA_ENDPOINT}/api/tags",
        "trace_id": trace_id,
    })


@app.post("/indexing/v1/jobs")
async def create_indexing_job(req: IndexJobRequest) -> JSONResponse:
    """Trigger indexing pipeline and return result synchronously (PoC)."""
    import uuid

    trace_id = req.trace_id or str(uuid.uuid4())
    bind_trace_id(trace_id)
    _logger.info("indexing.job.started job_id=%s version_id=%s", req.job_id, req.version_id)

    result = await run_pipeline(
        storage_path=req.storage_path,
        knowledge_id=req.version_id,
        index_base=req.index_base or INDEX_BASE,
        embed_model=req.embed_model,
        profile=req.profile,
        classification=req.classification,
    )

    _logger.info(
        "indexing.job.completed job_id=%s status=%s",
        req.job_id,
        result.get("status") if isinstance(result, dict) else None,
    )
    return JSONResponse(result)


@click.command()
@click.argument("manifest_path")
@click.option("--output-dir", default="./indexes")
@click.option("--model", default=EMBED_MODEL)
def main(manifest_path: str, output_dir: str, model: str) -> None:
    """CLI: Index a Knowledge package directly."""
    import json

    with open(manifest_path) as f:
        manifest = json.load(f)

    knowledge_id = manifest.get("id", "unknown")
    storage_path = str(Path(manifest_path).parent)

    result = asyncio.run(
        run_pipeline(
            storage_path=storage_path,
            knowledge_id=knowledge_id,
            index_base=output_dir,
            embed_model=model,
            classification=manifest.get("classification"),
        )
    )
    click.echo(json.dumps(result, indent=2))
