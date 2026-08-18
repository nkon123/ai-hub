"""Indexing Runtime — FastAPI server + CLI."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

import click
import httpx
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from observability import bind_trace_id, configure_logging
from pydantic import BaseModel

from indexing_runtime.embedders import (
    OLLAMA_ENDPOINT,
    is_embedding_capable,
    list_ollama_models,
)
from indexing_runtime.errors import ErrorCode, error_envelope, status_for
from indexing_runtime.loaders import (
    LOADED_SUFFIXES,
    MissingLoaderDependencyError,
    load_text_from_bytes,
)
from indexing_runtime.pipeline import run_pipeline
from indexing_runtime.settings import (
    BUILD_VERSION,
    COMMIT_SHA,
    EMBED_MODEL,
    EXTRACT_TEXT_EXCERPT_MAX_CHARS,
    EXTRACT_TEXT_MAX_UPLOAD_BYTES,
)

# Structured, Trace ID-carrying logs to stdout — see observability.logging_config
# for why a plain logging.basicConfig() call is not sufficient under uvicorn.
configure_logging("indexing-runtime")
_logger = logging.getLogger("indexing_runtime")

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # Emitted once so an operator reading this process's log can tell which
    # revision is actually in memory — see settings.BUILD_VERSION for the
    # stale-process incident that made this necessary across every service.
    _logger.info(
        "service.started service=indexing-runtime build_version=%s commit_sha=%s",
        BUILD_VERSION,
        COMMIT_SHA,
    )
    yield


app = FastAPI(title="Indexing Runtime", version=BUILD_VERSION, lifespan=lifespan)

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
    # Same shape portal-api / distribution-service / agent-runtime /
    # search-runtime return, so one operator check works across every service.
    return JSONResponse({"status": "ok", "version": BUILD_VERSION, "commit_sha": COMMIT_SHA})


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


async def _read_bounded_upload(file: UploadFile, max_bytes: int) -> bytes | None:
    """Read `file` in chunks, aborting once `max_bytes` is exceeded — bounds
    memory usage regardless of what the caller's `Content-Length` header
    claims (a lying/absent header must not defeat the cap). Returns `None`
    if the cap was exceeded."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/indexing/v1/extract-text")
async def extract_text(file: UploadFile = File(...)) -> JSONResponse:
    """Server-side text extraction for the P12 AI 추천 button's .pdf/.docx
    path (portal-web -> portal-api relay -> here, see
    `apps/portal-api/src/portal_api/routers/knowledge_text_extract.py`).
    portal-web already reads .md/.txt itself; a browser cannot parse PDF/Word
    binary formats, so this is the only place that can.

    Returns a BOUNDED plain-text excerpt (`EXTRACT_TEXT_EXCERPT_MAX_CHARS`),
    never the whole document — this is a metadata-suggestion input, not a
    document viewer. The uploaded file is read in-memory only; nothing is
    written to disk, and `file.filename` is used only to read its suffix
    (`load_text_from_bytes`) — never to build a filesystem path (root
    CLAUDE.md 코드 규칙).

    Three distinguishable failure states, on purpose (do not collapse them):
    - VALIDATION_ERROR (413): upload exceeds `EXTRACT_TEXT_MAX_UPLOAD_BYTES`,
      checked DURING the read (before any parsing) — an unbounded PDF/DOCX
      parse is a denial-of-service path.
    - VALIDATION_ERROR (422): the file's suffix isn't in `LOADED_SUFFIXES` —
      "이 형식은 추천을 지원하지 않습니다", a format nobody supports here.
    - DEPENDENCY_UNAVAILABLE (503): the suffix IS in `LOADED_SUFFIXES` but
      the optional `pypdf`/`python-docx` dependency isn't installed on this
      deployment (D-073) — "서버에 PDF/Word 추출 의존성이 설치되어 있지
      않습니다", a fact an operator can fix, unlike the format case.
    """
    import uuid

    trace_id = str(uuid.uuid4())
    bind_trace_id(trace_id)

    filename = file.filename or ""
    if not filename:
        return JSONResponse(
            status_code=status_for(ErrorCode.VALIDATION_ERROR),
            content=error_envelope(
                ErrorCode.VALIDATION_ERROR, "파일명이 없어 형식을 확인할 수 없습니다.", trace_id
            ),
        )

    raw = await _read_bounded_upload(file, EXTRACT_TEXT_MAX_UPLOAD_BYTES)
    if raw is None:
        max_mb = EXTRACT_TEXT_MAX_UPLOAD_BYTES // (1024 * 1024)
        _logger.warning("indexing.extract_text.upload_too_large trace_id=%s", trace_id)
        return JSONResponse(
            status_code=413,
            content=error_envelope(
                ErrorCode.VALIDATION_ERROR,
                f"업로드한 파일이 너무 큽니다(최대 {max_mb}MB). "
                "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
                trace_id,
            ),
        )

    suffix = Path(filename).suffix.lower()
    if suffix not in LOADED_SUFFIXES:
        _logger.info(
            "indexing.extract_text.unsupported_format trace_id=%s suffix=%s", trace_id, suffix
        )
        return JSONResponse(
            status_code=422,
            content=error_envelope(
                ErrorCode.VALIDATION_ERROR,
                f"{suffix or '이'} 형식은 추천을 지원하지 않습니다. "
                "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
                trace_id,
            ),
        )

    try:
        content = load_text_from_bytes(raw, filename)
    except MissingLoaderDependencyError as exc:
        # Never log the exception text into anything but this one-line
        # warning (no document bytes/content) — matches the "never log
        # prompt/document text" rule this endpoint's downstream caller
        # (knowledge_metadata_suggest) already follows.
        _logger.warning(
            "indexing.extract_text.dependency_unavailable trace_id=%s suffix=%s",
            trace_id,
            suffix,
        )
        return JSONResponse(
            status_code=status_for(ErrorCode.DEPENDENCY_UNAVAILABLE),
            content=error_envelope(ErrorCode.DEPENDENCY_UNAVAILABLE, str(exc), trace_id),
        )
    except ValueError:
        # Defense-in-depth: load_text_from_bytes independently checks
        # LOADED_SUFFIXES too; this mirrors the 422 above and should be
        # unreachable given the check already performed.
        return JSONResponse(
            status_code=422,
            content=error_envelope(
                ErrorCode.VALIDATION_ERROR,
                f"{suffix or '이'} 형식은 추천을 지원하지 않습니다. "
                "이름과 설명을 직접 입력해 등록을 진행할 수 있습니다.",
                trace_id,
            ),
        )

    excerpt = content.strip()[:EXTRACT_TEXT_EXCERPT_MAX_CHARS]
    if not excerpt:
        _logger.info("indexing.extract_text.empty_result trace_id=%s suffix=%s", trace_id, suffix)
        return JSONResponse(
            status_code=422,
            content=error_envelope(
                ErrorCode.VALIDATION_ERROR,
                "문서에서 추출한 내용이 비어 있습니다. 이름과 설명을 직접 입력해 주세요.",
                trace_id,
            ),
        )

    _logger.info("indexing.extract_text.completed trace_id=%s suffix=%s", trace_id, suffix)
    return JSONResponse({"excerpt": excerpt, "trace_id": trace_id})


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
