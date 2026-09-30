"""로컬 git 저장소를 들여다보는 stdio MCP 서버 — 파일 목록·내용, 검색, 커밋 이력, 변경 내용, blame (읽기 전용).

이 PC 에 이미 clone 된 저장소를 `git` 명령으로 읽는다. 네트워크·토큰·계정이 필요 없고,
작업 폴더(체크아웃)가 아니라 **git 객체**를 브랜치·태그·커밋 기준으로 읽는다. 저장소를 바꾸지
않는다(commit, checkout, fetch, pull 을 하지 않는다).

## Tool

- `git.list_repos`  — 등록된 저장소 이름.
- `git.list_files`  — 디렉터리 안의 파일·폴더(또는 하위 전체).
- `git.read_file`   — 파일 내용(줄 범위 지정 가능).
- `git.search`      — 저장소 안 문자열 검색(git grep). 기본은 글자 그대로, `regex` 로 정규식.
- `git.log`         — 커밋 이력(전체 또는 한 파일).
- `git.show_commit` — 한 커밋의 변경 파일 요약(원하면 diff 도).
- `git.diff`        — 두 ref(브랜치·태그·커밋) 사이의 변경.
- `git.blame`       — 한 파일의 줄별 마지막 수정자·커밋.

## 어떤 저장소를 볼 수 있나 — `repos.json`

같은 폴더의 `repos.json` 에 적은 저장소만 본다. 사용자가 넘긴 문자열을 경로로 쓰지 않고,
**이름 → 경로** 표에서만 찾는다.

    {"repos": {"ai-hub": "C:/Dev/ai-hub"}}

`repos.example.json` 을 복사해 고친다. 서버는 환경변수를 못 받아서(`env={}`) 설정 파일로
받는다. Desktop 에서는 폴더 전체가 복사되어 실행되므로 **`repos.json` 을 고친 뒤 서버를 삭제하고
다시 추가**해야 반영된다. `git` 실행 파일이 PATH 에 없으면 `repos.json` 에 `"git": "C:/.../git.exe"`.

## 안전 장치

- 읽기 전용 git 명령만 부른다. 인자는 배열로 넘기고 셸을 쓰지 않는다.
- ref(브랜치·커밋)와 경로는 허용 문자만 통과시킨다: `-` 로 시작하거나 `..`·`:` 가 있으면 거절
  (옵션 삽입·경로 이탈 방지).
- `.env`, 키·인증서, `id_rsa*`, `credentials*`, `secrets*` 같은 **비밀값이 있을 법한 파일**은
  읽지 않고, 검색·diff 결과에서도 뺀다(이름이 그렇게 생긴 파일만 — 내용은 검사하지 않는다).
- 저장소 설정이 외부 프로그램을 돌리지 못하게 `--no-ext-diff --no-textconv` 를 쓰고 fsmonitor 를 끈다.
- 출력 길이·개수·시간에 상한이 있다.

## 실행 / 점검

인자가 없으면 stdio 서버로 뜬다. 인자가 있으면 서버를 띄우지 않고 점검만 한다:

    server.py --check
    server.py --list-tools
    server.py --call git.list_files --args "{\"path\": \"docs\"}"
    server.py --help
"""

from __future__ import annotations

import argparse
import asyncio
import fnmatch
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "mcp-server-manifest.json"
CONFIG_PATH = HERE / "repos.json"

GIT_TIMEOUT_SECONDS = 30
MAX_GIT_OUTPUT_BYTES = 2_000_000
MAX_LIST_ENTRIES = 500
MAX_LOG_ENTRIES = 50
MAX_SEARCH_RESULTS = 100
DEFAULT_SEARCH_RESULTS = 30
MAX_BLAME_LINES = 200
DEFAULT_READ_CHARS = 8000
MAX_READ_CHARS = 40000
DEFAULT_PATCH_CHARS = 12000
MAX_PATCH_CHARS = 40000
MAX_QUERY_CHARS = 200
LINE_CLIP = 240

_WINDOWS_GIT_CANDIDATES = (
    "C:/Program Files/Git/cmd/git.exe",
    "C:/Program Files (x86)/Git/cmd/git.exe",
    "C:/Program Files/Git/bin/git.exe",
)
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_REF = re.compile(r"^[A-Za-z0-9_./~^@{}-]{1,200}$")

# 비밀값이 들어 있을 법한 파일 이름. 이름만 본다(내용은 검사하지 않는다).
_SECRET_GLOBS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12",
    "*.jks",
    "*.keystore",
    "*.kdbx",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    "credentials*",
    "secrets*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
)
# git pathspec 으로도 뺀다(검색·diff·show). `**/` 는 저장소 루트 바로 아래도 포함한다.
_EXCLUDE_PATHSPECS = [f":(exclude,glob)**/{g}" for g in _SECRET_GLOBS]


class ToolError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 실패 — 무엇을 고치면 되는지 담는다."""


# --------------------------------------------------------------------------- 설정과 검증


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise ToolError(
            "repos.json 이 없습니다. repos.example.json 을 repos.json 으로 복사해 저장소 경로를 적은 뒤, "
            "이 서버를 삭제하고 다시 추가하세요."
        )
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ToolError(f"repos.json 을 읽을 수 없습니다: {exc}") from None
    repos = config.get("repos")
    if not isinstance(repos, dict) or not repos:
        raise ToolError('repos.json 에 "repos": {"이름": "경로"} 가 비어 있습니다.')
    for name, path in repos.items():
        if not _NAME.match(str(name)) or not isinstance(path, str) or not path.strip():
            raise ToolError(f"repos.json 의 항목이 올바르지 않습니다: {name!r}")
    return config


def repo_names() -> list[str]:
    return sorted(load_config()["repos"])


def resolve_repo(name: Any) -> str:
    config = load_config()
    repos = config["repos"]
    if name in (None, ""):
        if len(repos) == 1:
            return str(next(iter(repos.values())))
        raise ToolError("repo 를 지정하세요. 등록된 저장소: " + ", ".join(sorted(repos)))
    if not isinstance(name, str) or name not in repos:
        raise ToolError(f"등록되지 않은 저장소입니다: {name!r}. 등록된 저장소: " + ", ".join(sorted(repos)))
    return str(repos[name])


def git_executable() -> str:
    configured = None
    try:
        configured = load_config().get("git")
    except ToolError:
        pass
    if configured:
        return str(configured)
    found = shutil.which("git")
    if found:
        return found
    for candidate in _WINDOWS_GIT_CANDIDATES:
        if pathlib.Path(candidate).exists():
            return candidate
    raise ToolError('git 을 찾을 수 없습니다. repos.json 에 "git": "C:/.../git.exe" 를 적으세요.')


def clean_ref(value: Any, default: str = "HEAD") -> str:
    ref = default if value in (None, "") else str(value).strip()
    # 앞의 '-' 는 옵션 삽입, '..' 는 범위, ':' 는 `ref:경로` 식을 흔든다.
    if not _REF.match(ref) or ref.startswith("-") or ".." in ref:
        raise ToolError(f"올바르지 않은 ref 입니다: {ref!r} (브랜치·태그·커밋 이름만 가능)")
    return ref


def clean_path(value: Any, *, required: bool = False) -> str:
    raw = "" if value in (None, "") else str(value).strip().replace("\\", "/")
    if not raw:
        if required:
            raise ToolError("path 가 필요합니다.")
        return ""
    if any(ord(c) < 32 for c in raw) or raw.startswith(("/", "-")) or re.match(r"^[A-Za-z]:", raw):
        raise ToolError(f"올바르지 않은 경로입니다: {raw!r} (저장소 루트 기준 상대 경로)")
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if ".." in parts:
        raise ToolError(f"올바르지 않은 경로입니다: {raw!r} ('..' 는 쓸 수 없습니다)")
    return "/".join(parts)


def is_secret_path(path: str) -> bool:
    base = path.rsplit("/", 1)[-1].lower()
    return any(fnmatch.fnmatch(base, g) for g in _SECRET_GLOBS)


def clip(text: str, limit: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= limit else (text[:limit].rstrip() + "…", True)


# --------------------------------------------------------------------------- git 실행


def run_git(root: str, args: list[str], *, max_bytes: int = MAX_GIT_OUTPUT_BYTES) -> tuple[bytes, bool]:
    """읽기 전용 git 을 한 번 실행한다. (stdout, 잘렸는가). 실패하면 `ToolError`."""
    cmd = [
        git_executable(),
        "-C",
        root,
        "--no-pager",
        "-c",
        "core.quotepath=false",
        "-c",
        "core.fsmonitor=false",
        *args,
    ]
    env = {
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_PAGER": "cat",
    }
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.Popen(  # noqa: S603 — 인자 배열, 셸 없음
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            creationflags=flags,
        )
    except OSError as exc:
        raise ToolError(f"git 을 실행하지 못했습니다: {type(exc).__name__}") from None

    out = bytearray()
    err = bytearray()
    overflow = threading.Event()

    def pump_stdout() -> None:
        while chunk := proc.stdout.read(65536):  # type: ignore[union-attr]
            room = max_bytes - len(out)
            out.extend(chunk[:room])
            if len(chunk) > room:
                overflow.set()
                proc.kill()  # 상한을 넘으면 더 읽지 않는다
                return

    def pump_stderr() -> None:
        while chunk := proc.stderr.read(4096):  # type: ignore[union-attr]
            if len(err) < 8192:
                err.extend(chunk[: 8192 - len(err)])

    threads = [threading.Thread(target=pump_stdout, daemon=True), threading.Thread(target=pump_stderr, daemon=True)]
    for t in threads:
        t.start()
    deadline = time.monotonic() + GIT_TIMEOUT_SECONDS
    for t in threads:
        t.join(max(deadline - time.monotonic(), 0))
    if any(t.is_alive() for t in threads):
        proc.kill()
        raise ToolError(f"git 이 {GIT_TIMEOUT_SECONDS}초 안에 끝나지 않아 중단했습니다.")
    proc.wait()
    truncated = overflow.is_set()
    if proc.returncode not in (0, 1) and not truncated:  # grep 은 결과 없음이 1
        message = bytes(err).decode("utf-8", "replace").strip().splitlines()
        hint = message[-1] if message else "알 수 없는 오류"
        if "dubious ownership" in hint:
            hint = "이 저장소의 소유자가 현재 사용자와 달라 git 이 거부했습니다(safe.directory)."
        raise ToolError(f"git 명령이 실패했습니다: {clip(hint, 200)[0]}")
    return bytes(out), truncated


def text_of(data: bytes) -> str:
    return data.decode("utf-8", "replace")


# --------------------------------------------------------------------------- Tool 스키마

_REPO = {
    "type": "string",
    "maxLength": 64,
    "description": "저장소 이름. 등록된 저장소가 하나뿐이면 생략한다.",
}
_REF_PROP = {
    "type": "string",
    "maxLength": 200,
    "description": "브랜치·태그·커밋 이름. 생략하면 HEAD(현재 브랜치 끝).",
}


def _schema(properties: dict, required: list[str] | None = None) -> dict:
    schema: dict = {"type": "object", "additionalProperties": False, "properties": properties}
    if required:
        schema["required"] = required
    return schema


LIST_REPOS_SCHEMA = _schema({})
LIST_FILES_SCHEMA = _schema(
    {
        "repo": _REPO,
        "ref": _REF_PROP,
        "path": {"type": "string", "maxLength": 300, "description": "볼 디렉터리(저장소 루트 기준). 생략하면 루트."},
        "recursive": {"type": "boolean", "description": "하위 폴더까지 전부 (기본 false)."},
    }
)
READ_FILE_SCHEMA = _schema(
    {
        "repo": _REPO,
        "ref": _REF_PROP,
        "path": {"type": "string", "minLength": 1, "maxLength": 300, "description": "읽을 파일(저장소 루트 기준)."},
        "start_line": {"type": "integer", "minimum": 1, "description": "시작 줄 (선택)."},
        "end_line": {"type": "integer", "minimum": 1, "description": "끝 줄 (선택)."},
        "max_chars": {
            "type": "integer",
            "minimum": 200,
            "maximum": MAX_READ_CHARS,
            "description": f"글자 수 상한 (기본 {DEFAULT_READ_CHARS}).",
        },
    },
    ["path"],
)
SEARCH_SCHEMA = _schema(
    {
        "repo": _REPO,
        "ref": _REF_PROP,
        "query": {"type": "string", "minLength": 1, "maxLength": MAX_QUERY_CHARS, "description": "찾을 글자."},
        "path": {"type": "string", "maxLength": 300, "description": "이 폴더·파일 안에서만 (선택)."},
        "regex": {"type": "boolean", "description": "query 를 정규식(확장)으로 (기본 false = 글자 그대로)."},
        "ignore_case": {"type": "boolean", "description": "대소문자 무시 (기본 false)."},
        "max_results": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_SEARCH_RESULTS,
            "description": f"최대 개수 (기본 {DEFAULT_SEARCH_RESULTS}).",
        },
    },
    ["query"],
)
LOG_SCHEMA = _schema(
    {
        "repo": _REPO,
        "ref": _REF_PROP,
        "path": {"type": "string", "maxLength": 300, "description": "이 파일·폴더를 바꾼 커밋만 (선택)."},
        "max_count": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_LOG_ENTRIES,
            "description": "최대 개수 (기본 20). 최신 커밋부터.",
        },
    }
)
SHOW_SCHEMA = _schema(
    {
        "repo": _REPO,
        "commit": {"type": "string", "maxLength": 200, "description": "커밋 해시·태그·브랜치. 생략하면 HEAD."},
        "patch": {"type": "boolean", "description": "변경 내용(diff)까지 (기본 false = 바뀐 파일 요약만)."},
        "max_chars": {
            "type": "integer",
            "minimum": 500,
            "maximum": MAX_PATCH_CHARS,
            "description": f"diff 글자 수 상한 (기본 {DEFAULT_PATCH_CHARS}).",
        },
    }
)
DIFF_SCHEMA = _schema(
    {
        "repo": _REPO,
        "from_ref": {"type": "string", "minLength": 1, "maxLength": 200, "description": "비교의 기준(이전) ref."},
        "to_ref": {"type": "string", "maxLength": 200, "description": "비교 대상(이후) ref. 생략하면 HEAD."},
        "path": {"type": "string", "maxLength": 300, "description": "이 파일·폴더만 (선택)."},
        "patch": {"type": "boolean", "description": "변경 내용(diff)까지 (기본 false = 바뀐 파일 요약만)."},
        "max_chars": {
            "type": "integer",
            "minimum": 500,
            "maximum": MAX_PATCH_CHARS,
            "description": f"diff 글자 수 상한 (기본 {DEFAULT_PATCH_CHARS}).",
        },
    },
    ["from_ref"],
)
BLAME_SCHEMA = _schema(
    {
        "repo": _REPO,
        "ref": _REF_PROP,
        "path": {"type": "string", "minLength": 1, "maxLength": 300, "description": "파일(저장소 루트 기준)."},
        "start_line": {"type": "integer", "minimum": 1, "description": "시작 줄 (기본 1)."},
        "end_line": {"type": "integer", "minimum": 1, "description": f"끝 줄 (최대 {MAX_BLAME_LINES}줄 범위)."},
    },
    ["path"],
)


def _int(arguments: dict, key: str, default: int | None, low: int, high: int | None = None) -> int | None:
    value = arguments.get(key, default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < low or (high is not None and value > high):
        raise ToolError(f"{key} 는 {low}~{high} 사이 정수입니다." if high is not None else f"{key} 는 {low} 이상 정수입니다.")
    return value


# --------------------------------------------------------------------------- Tool 처리


def _list_repos(arguments: dict) -> dict:  # noqa: ARG001
    names = repo_names()
    return {"repos": names, "text": "등록된 저장소: " + ", ".join(names)}


def _list_files(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    ref = clean_ref(arguments.get("ref"))
    path = clean_path(arguments.get("path"))
    recursive = bool(arguments.get("recursive", False))
    args = ["ls-tree", "-l", "-z", "--full-name"] + (["-r"] if recursive else []) + ["--end-of-options", ref]
    if path:
        args += ["--", path + "/"]
    out, _ = run_git(root, args)
    entries: list[dict] = []
    for record in text_of(out).split("\0"):
        if not record.strip():
            continue
        meta, _, name = record.partition("\t")
        fields = meta.split()
        if len(fields) < 4 or is_secret_path(name):
            continue
        kind = "dir" if fields[1] == "tree" else "file" if fields[1] == "blob" else fields[1]
        entries.append({"path": name, "type": kind, "size": None if fields[3] == "-" else int(fields[3])})
    truncated = len(entries) > MAX_LIST_ENTRIES
    entries = entries[:MAX_LIST_ENTRIES]
    if not entries and path:
        raise ToolError(f"{ref} 에 '{path}' 디렉터리가 없습니다. 파일이라면 git.read_file 을 쓰세요.")
    lines = [f"{'📁' if e['type'] == 'dir' else '  '} {e['path']}" + ("" if e["size"] is None else f"  ({e['size']}B)") for e in entries]
    head = f"{ref} : {path or '/'} — {len(entries)}개" + (" (일부만)" if truncated else "")
    return {"ref": ref, "path": path, "truncated": truncated, "entries": entries, "text": head + "\n" + "\n".join(lines)}


def _read_file(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    ref = clean_ref(arguments.get("ref"))
    path = clean_path(arguments.get("path"), required=True)
    if is_secret_path(path):
        raise ToolError("비밀값이 들어 있을 수 있는 파일 이름이라 읽지 않습니다.")
    max_chars = _int(arguments, "max_chars", DEFAULT_READ_CHARS, 200, MAX_READ_CHARS)
    start = _int(arguments, "start_line", None, 1)
    end = _int(arguments, "end_line", None, 1)
    if start and end and end < start:
        raise ToolError("end_line 은 start_line 보다 작을 수 없습니다.")
    kind, _ = run_git(root, ["cat-file", "-t", "--end-of-options", f"{ref}:{path}"])
    if text_of(kind).strip() != "blob":
        raise ToolError(f"'{path}' 는 파일이 아닙니다. 디렉터리라면 git.list_files 를 쓰세요.")
    data, raw_truncated = run_git(root, ["cat-file", "blob", "--end-of-options", f"{ref}:{path}"])
    if b"\0" in data[:8000]:
        raise ToolError("바이너리 파일이라 읽지 않습니다.")
    lines = text_of(data).replace("\r\n", "\n").split("\n")
    total = len(lines)
    lo = (start or 1) - 1
    hi = end or total
    picked = lines[lo:hi]
    numbered = "\n".join(f"{lo + i + 1:>5}  {line}" for i, line in enumerate(picked))
    body, cut = clip(numbered, max_chars)
    truncated = cut or raw_truncated
    note = f"{ref}:{path} — 줄 {lo + 1}~{lo + len(picked)} / 전체 {total}줄" + (" (글자 수 상한으로 뒤가 잘림)" if truncated else "")
    return {"ref": ref, "path": path, "total_lines": total, "truncated": truncated, "text": note + "\n" + body}


def _search(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    ref = clean_ref(arguments.get("ref"))
    path = clean_path(arguments.get("path"))
    query = str(arguments.get("query") or "")
    if not query.strip() or "\n" in query or "\r" in query or len(query) > MAX_QUERY_CHARS:
        raise ToolError(f"query 는 한 줄, 최대 {MAX_QUERY_CHARS}자입니다.")
    limit = _int(arguments, "max_results", DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS)
    args = ["grep", "-n", "--null", "-I", "--no-color"]
    args.append("-E" if arguments.get("regex") else "-F")
    if arguments.get("ignore_case"):
        args.append("-i")
    args += ["-e", query, "--end-of-options", ref, "--", path or ".", *_EXCLUDE_PATHSPECS]
    out, raw_truncated = run_git(root, args)
    hits: list[dict] = []
    prefix = ref + ":"
    for record in out.split(b"\n"):
        parts = record.split(b"\0", 2)
        if len(parts) != 3:
            continue
        file_name = text_of(parts[0])
        file_name = file_name[len(prefix):] if file_name.startswith(prefix) else file_name
        text, _ = clip(text_of(parts[2]).strip(), LINE_CLIP)
        hits.append({"path": file_name, "line": int(parts[1] or 0), "text": text})
    truncated = len(hits) > limit or raw_truncated
    hits = hits[:limit]
    head = f"'{query}' 검색 ({ref}) — {len(hits)}건" + (" (일부만)" if truncated else "")
    lines = [f"{h['path']}:{h['line']}: {h['text']}" for h in hits]
    return {"ref": ref, "query": query, "count": len(hits), "truncated": truncated, "matches": hits, "text": head + "\n" + "\n".join(lines)}


def _log(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    ref = clean_ref(arguments.get("ref"))
    path = clean_path(arguments.get("path"))
    count = _int(arguments, "max_count", 20, 1, MAX_LOG_ENTRIES)
    fmt = "%h%x1f%an%x1f%ad%x1f%s%x1e"
    args = ["log", "--no-color", "--no-ext-diff", "--date=short", f"--format={fmt}", "-n", str(count), "--end-of-options", ref]
    if path:
        args += ["--", path]
    out, _ = run_git(root, args)
    commits: list[dict] = []
    for record in text_of(out).split("\x1e"):
        fields = record.strip("\n").split("\x1f")
        if len(fields) == 4:
            commits.append({"commit": fields[0], "author": fields[1], "date": fields[2], "subject": clip(fields[3], LINE_CLIP)[0]})
    where = f" — {path}" if path else ""
    lines = [f"{c['commit']} {c['date']} {c['author']}: {c['subject']}" for c in commits]
    return {"ref": ref, "path": path, "commits": commits, "text": f"{ref} 커밋 {len(commits)}개{where}\n" + "\n".join(lines)}


def _patch_command(kind: str, revisions: list[str], patch: bool, path: str) -> list[str]:
    args = [kind, "--no-color", "--no-ext-diff", "--no-textconv", "--stat=120"]
    if patch:
        args.append("--patch")
    elif kind == "show":
        args.append("--format=%h %an %ad%n%s%n%n%b")
    if kind == "show":
        args.append("--date=short")
    args += ["--end-of-options", *revisions, "--", path or ".", *_EXCLUDE_PATHSPECS]
    return args


def _show_commit(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    commit = clean_ref(arguments.get("commit"))
    max_chars = _int(arguments, "max_chars", DEFAULT_PATCH_CHARS, 500, MAX_PATCH_CHARS)
    patch = bool(arguments.get("patch", False))
    out, raw_truncated = run_git(root, _patch_command("show", [commit], patch, ""))
    body, cut = clip(text_of(out).strip(), max_chars)
    return {"commit": commit, "patch": patch, "truncated": cut or raw_truncated, "text": body + ("\n…(잘림)" if cut or raw_truncated else "")}


def _diff(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    from_ref = clean_ref(arguments.get("from_ref"))
    to_ref = clean_ref(arguments.get("to_ref"))
    path = clean_path(arguments.get("path"))
    max_chars = _int(arguments, "max_chars", DEFAULT_PATCH_CHARS, 500, MAX_PATCH_CHARS)
    patch = bool(arguments.get("patch", False))
    out, raw_truncated = run_git(root, _patch_command("diff", [from_ref, to_ref], patch, path))
    text = text_of(out).strip() or "변경 내용이 없습니다."
    body, cut = clip(text, max_chars)
    return {
        "from_ref": from_ref,
        "to_ref": to_ref,
        "patch": patch,
        "truncated": cut or raw_truncated,
        "text": f"{from_ref} → {to_ref}\n{body}" + ("\n…(잘림)" if cut or raw_truncated else ""),
    }


def _blame(arguments: dict) -> dict:
    root = resolve_repo(arguments.get("repo"))
    ref = clean_ref(arguments.get("ref"))
    path = clean_path(arguments.get("path"), required=True)
    if is_secret_path(path):
        raise ToolError("비밀값이 들어 있을 수 있는 파일 이름이라 읽지 않습니다.")
    start = _int(arguments, "start_line", 1, 1)
    end = _int(arguments, "end_line", None, 1)
    end = end if end is not None else start + 49
    if end < start or end - start + 1 > MAX_BLAME_LINES:
        raise ToolError(f"줄 범위는 start_line 이상, 최대 {MAX_BLAME_LINES}줄입니다.")
    out, raw_truncated = run_git(root, ["blame", "--date=short", "-w", "-L", f"{start},{end}", ref, "--", path])
    lines = [clip(line, LINE_CLIP)[0] for line in text_of(out).splitlines()]
    return {"ref": ref, "path": path, "start_line": start, "end_line": end, "truncated": raw_truncated, "text": f"{ref}:{path} 줄 {start}~{end}\n" + "\n".join(lines)}


_HANDLERS = {
    "git.list_repos": _list_repos,
    "git.list_files": _list_files,
    "git.read_file": _read_file,
    "git.search": _search,
    "git.log": _log,
    "git.show_commit": _show_commit,
    "git.diff": _diff,
    "git.blame": _blame,
}

_DESCRIPTIONS = {
    "git.list_repos": "볼 수 있는 git 저장소 이름 목록. 저장소가 여러 개라 이름을 모를 때 쓴다.",
    "git.list_files": "git 저장소의 폴더 안 파일·폴더 목록. '저장소에 어떤 파일이 있어', '폴더 구조 보여줘'에 쓴다.",
    "git.read_file": "git 저장소의 파일 내용 읽기(줄 범위 지정 가능). '~ 파일 보여줘/읽어줘'에 쓴다. 경로를 알아야 한다.",
    "git.search": "git 저장소 전체에서 글자를 검색해 파일·줄을 알려준다. '~가 어디 있어', '~ 사용하는 곳 찾아줘'에 쓴다.",
    "git.log": "git 커밋 목록(해시·날짜·작성자·제목). '최근 커밋 보여줘', '이 파일 변경 이력'에 쓴다. 커밋 안의 변경 내용은 아님.",
    "git.show_commit": "git 커밋 하나에서 어떤 파일이 어떻게 바뀌었는지. 'HEAD/이 커밋에서 뭐가 바뀌었어'에 쓴다.",
    "git.diff": "git 두 브랜치·태그·커밋 사이의 변경 내용. '~와 ~ 차이', '이번 릴리스에서 바뀐 것'에 쓴다.",
    "git.blame": "git 파일의 줄별 마지막 수정자·커밋. '이 줄 누가 썼어'에 쓴다.",
}
_SCHEMAS = {
    "git.list_repos": LIST_REPOS_SCHEMA,
    "git.list_files": LIST_FILES_SCHEMA,
    "git.read_file": READ_FILE_SCHEMA,
    "git.search": SEARCH_SCHEMA,
    "git.log": LOG_SCHEMA,
    "git.show_commit": SHOW_SCHEMA,
    "git.diff": DIFF_SCHEMA,
    "git.blame": BLAME_SCHEMA,
}


async def on_list_tools(ctx, params) -> types.ListToolsResult:  # noqa: ARG001
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name=name,
                description=_DESCRIPTIONS[name],
                input_schema=_SCHEMAS[name],
                annotations=types.ToolAnnotations(read_only_hint=True),
            )
            for name in _HANDLERS
        ]
    )


async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:  # noqa: ARG001
    handler = _HANDLERS.get(params.name)
    if handler is None:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"알 수 없는 Tool 입니다: {params.name}")],
            is_error=True,
        )
    try:
        # git 실행은 블로킹이다 — 이벤트 루프를 막지 않도록 작업 스레드에서 돈다.
        data = await asyncio.to_thread(handler, dict(params.arguments or {}))
    except ToolError as exc:
        return types.CallToolResult(content=[types.TextContent(type="text", text=str(exc))], is_error=True)
    text = data.pop("text")
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], structured_content=data)


# --------------------------------------------------------------------------- 터미널 점검


def _schema_of(tool: types.Tool) -> dict:
    return getattr(tool, "input_schema", None) or getattr(tool, "inputSchema", {})


def _tools() -> list[types.Tool]:
    return asyncio.run(on_list_tools(None, None)).tools


def _load_manifest(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_list_tools(_args: argparse.Namespace) -> int:
    for tool in _tools():
        print(f"{tool.name}\n  {tool.description}")
        print("  입력: " + json.dumps(_schema_of(tool), ensure_ascii=False))
    return 0


def cmd_call(args: argparse.Namespace) -> int:
    if args.call not in {t.name for t in _tools()}:
        print(f"없는 Tool 입니다: {args.call}", file=sys.stderr)
        return 1
    try:
        arguments = json.loads(args.args)
    except json.JSONDecodeError as exc:
        print(f"--args 가 올바른 JSON 이 아닙니다: {exc}", file=sys.stderr)
        return 1
    result = asyncio.run(on_call_tool(None, types.CallToolRequestParams(name=args.call, arguments=arguments)))
    for item in result.content:
        print(getattr(item, "text", item))
    return 1 if result.is_error else 0


def cmd_check(args: argparse.Namespace) -> int:
    """등록·연결에서 실제로 막히는 것들. 통과하면 0, 하나라도 걸리면 1."""
    problems: list[str] = []
    if not args.manifest.exists():
        print(f"매니페스트가 없습니다: {args.manifest}", file=sys.stderr)
        return 1
    manifest = _load_manifest(args.manifest)

    transport = manifest.get("transport") or {}
    entrypoint = transport.get("entrypoint")
    if entrypoint and not args.manifest.with_name(pathlib.PurePosixPath(entrypoint).name).exists():
        problems.append(f"transport.entrypoint '{entrypoint}' 가 이 폴더에 없습니다.")
    stray = [a for a in transport.get("args", []) if str(a).startswith("--")]
    if stray:
        problems.append(f"transport.args 에 플래그가 있습니다: {stray} — 서버가 뜨지 않습니다.")

    live = {t.name: _schema_of(t) for t in _tools()}
    declared = {t["tool_name"]: t for t in manifest.get("declared_tools", [])}
    for name in sorted(set(live) - set(declared)):
        problems.append(f"'{name}' 은 서버가 내보내는데 declared_tools 에 없습니다.")
    for name in sorted(set(declared) - set(live)):
        problems.append(f"'{name}' 은 declared_tools 에 있는데 서버가 내보내지 않습니다.")
    for name in sorted(set(live) & set(declared)):
        if live[name] != declared[name].get("input_schema"):
            problems.append(f"'{name}' 의 input_schema 가 매니페스트와 다릅니다.")
    for name, tool in sorted(declared.items()):
        perms = tool.get("permissions") or {}
        for key in ("allowed_roles", "allowed_orgs"):
            if not perms.get(key):
                problems.append(f"'{name}' 의 permissions.{key} 가 비어 있습니다 (아무도 호출할 수 없습니다).")
        if tool.get("risk_level") == "WRITE" and tool.get("confirmation_policy") == "NEVER":
            problems.append(f"'{name}' 은 WRITE 인데 confirmation_policy 가 NEVER 입니다.")

    # 설정과 저장소 — 이것이 없으면 서버는 뜨지만 모든 호출이 실패한다.
    try:
        config = load_config()
        for name, path in sorted(config["repos"].items()):
            try:
                run_git(str(path), ["rev-parse", "--git-dir"])
            except ToolError as exc:
                problems.append(f"저장소 '{name}' ({path}): {exc}")
    except ToolError as exc:
        problems.append(str(exc))

    if problems:
        print(f"문제 {len(problems)}건", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"이상 없음 — Tool {len(live)}개, 저장소 {len(config['repos'])}개, 매니페스트 {args.manifest.name}")
    return 0


def run_cli(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(
        prog="server.py",
        description="git-repo 점검 모드. 인자가 없으면 stdio MCP 서버로 뜹니다.",
    )
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST, help="검사할 매니페스트 (기본: 이 파일과 같은 폴더)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="매니페스트·설정·저장소 검사")
    mode.add_argument("--list-tools", action="store_true", dest="list_tools", help="Tool 목록 출력")
    mode.add_argument("--call", metavar="TOOL", help="Tool 하나를 실제로 호출")
    parser.add_argument("--args", default="{}", metavar="JSON", help="--call 에 넘길 인자 (기본 {})")
    args = parser.parse_args(argv)
    if args.check:
        return cmd_check(args)
    if args.list_tools:
        return cmd_list_tools(args)
    return cmd_call(args)


async def serve() -> None:
    server = Server(
        "git-repo",
        version="1.0.0",
        instructions="이 PC 의 git 저장소를 읽습니다(파일·검색·이력·diff·blame). 저장소를 바꾸지 않습니다.",
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    if sys.argv[1:]:
        raise SystemExit(run_cli(sys.argv[1:]))
    asyncio.run(serve())
