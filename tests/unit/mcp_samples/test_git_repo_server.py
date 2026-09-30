"""`samples/mcp-servers/git-repo` — 실제 git 으로 임시 저장소를 만들어 시험한다.

고정할 것: 각 Tool 이 맞게 읽는가, 그리고 **입력이 git 옵션·경로로 새지 않는가**
(`--output=`, `..`, `ref:path`), 비밀값 파일이 읽기·검색·diff 어디에도 나오지 않는가,
등록되지 않은 저장소를 볼 수 없는가, 출력 상한이 지켜지는가.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import mcp.types as types
import pytest

SERVER_DIR = Path(__file__).resolve().parents[3] / "samples" / "mcp-servers" / "git-repo"

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git 이 필요합니다")


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "work"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    (root / "README.md").write_text("# 제목\n첫 줄 ALPHA\n셋째 줄\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (root / ".env").write_text("TOKEN=super-secret-alpha\n", encoding="utf-8")
    (root / "src" / "server.key").write_bytes(b"-----BEGIN KEY----- alpha")
    (root / "logo.bin").write_bytes(b"\x00\x01\x02binary alpha")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "첫 커밋")
    (root / "src" / "app.py").write_text("def alpha():\n    return 2\n", encoding="utf-8")
    (root / ".env").write_text("TOKEN=changed-secret-alpha\n", encoding="utf-8")
    _git(root, "commit", "-q", "-am", "alpha 반환값 변경")
    _git(root, "tag", "v1")
    return root


@pytest.fixture()
def server(repo: Path, tmp_path: Path):
    spec = importlib.util.spec_from_file_location("git_repo_server_under_test", SERVER_DIR / "server.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    config = tmp_path / "repos.json"
    config.write_text(json.dumps({"repos": {"demo": str(repo).replace("\\", "/")}}), encoding="utf-8")
    module.CONFIG_PATH = config
    yield module
    sys.modules.pop(spec.name, None)


def call(server, name: str, arguments: dict | None = None) -> types.CallToolResult:
    return asyncio.run(server.on_call_tool(None, types.CallToolRequestParams(name=name, arguments=arguments or {})))


def text(result: types.CallToolResult) -> str:
    return result.content[0].text


# --------------------------------------------------------------------------- 읽기


def test_list_repos_and_default_repo(server) -> None:
    assert "demo" in text(call(server, "git.list_repos"))
    # 저장소가 하나뿐이면 repo 를 생략해도 된다.
    assert not call(server, "git.list_files").is_error


def test_list_files_root_and_subdir_hide_secret_names(server) -> None:
    root = call(server, "git.list_files")
    names = [e["path"] for e in root.structured_content["entries"]]
    assert "README.md" in names and "src" in names and ".env" not in names
    sub = call(server, "git.list_files", {"path": "src"})
    sub_names = [e["path"] for e in sub.structured_content["entries"]]
    assert "src/app.py" in sub_names and "src/server.key" not in sub_names


def test_list_files_recursive(server) -> None:
    result = call(server, "git.list_files", {"recursive": True})
    paths = {e["path"] for e in result.structured_content["entries"]}
    assert {"README.md", "src/app.py", "logo.bin"} <= paths
    assert ".env" not in paths


def test_read_file_with_line_range_and_ref(server) -> None:
    result = call(server, "git.read_file", {"path": "README.md", "start_line": 2, "end_line": 2})
    assert not result.is_error and "첫 줄 ALPHA" in text(result) and "셋째 줄" not in text(result)
    old = call(server, "git.read_file", {"path": "src/app.py", "ref": "HEAD~1"})
    new = call(server, "git.read_file", {"path": "src/app.py", "ref": "v1"})
    assert "return 1" in text(old) and "return 2" in text(new)


def test_read_file_refuses_binary_directory_and_missing(server) -> None:
    assert "바이너리" in text(call(server, "git.read_file", {"path": "logo.bin"}))
    assert "파일이 아닙니다" in text(call(server, "git.read_file", {"path": "src"}))
    assert call(server, "git.read_file", {"path": "nope.txt"}).is_error


def test_read_file_truncates_at_max_chars(server, repo: Path) -> None:
    (repo / "big.txt").write_text("\n".join(f"line {i}" for i in range(2000)), encoding="utf-8")
    _git(repo, "add", "big.txt")
    _git(repo, "commit", "-q", "-m", "big")
    result = call(server, "git.read_file", {"path": "big.txt", "max_chars": 500})
    assert result.structured_content["truncated"] is True
    assert len(text(result)) < 800


def test_search_finds_matches_and_never_returns_secret_files(server) -> None:
    result = call(server, "git.search", {"query": "alpha", "ignore_case": True})
    files = {m["path"] for m in result.structured_content["matches"]}
    assert {"README.md", "src/app.py"} <= files
    assert ".env" not in files and "src/server.key" not in files
    assert "super-secret" not in text(result) and "BEGIN KEY" not in text(result)


def test_search_is_literal_by_default_and_regex_on_request(server) -> None:
    assert call(server, "git.search", {"query": "def (alpha"}).structured_content["count"] == 0
    hit = call(server, "git.search", {"query": "def (alpha|beta)", "regex": True})
    assert hit.structured_content["count"] == 1


def test_search_no_match_is_not_an_error(server) -> None:
    result = call(server, "git.search", {"query": "zzz-not-there"})
    assert not result.is_error and result.structured_content["count"] == 0


def test_search_respects_max_results(server) -> None:
    result = call(server, "git.search", {"query": "a", "ignore_case": True, "max_results": 1})
    assert result.structured_content["count"] == 1 and result.structured_content["truncated"] is True


def test_log_all_and_for_one_file(server) -> None:
    everything = call(server, "git.log", {"max_count": 5})
    assert [c["subject"] for c in everything.structured_content["commits"]] == ["alpha 반환값 변경", "첫 커밋"]
    assert "@" not in text(everything)  # 이메일은 내보내지 않는다
    only = call(server, "git.log", {"path": "README.md"})
    assert [c["subject"] for c in only.structured_content["commits"]] == ["첫 커밋"]


def test_show_commit_stat_and_patch_exclude_secret_changes(server) -> None:
    stat = call(server, "git.show_commit", {"commit": "HEAD"})
    assert "src/app.py" in text(stat) and ".env" not in text(stat)
    patch = call(server, "git.show_commit", {"commit": "HEAD", "patch": True})
    assert "-    return 1" in text(patch) and "+    return 2" in text(patch)
    assert "changed-secret" not in text(patch) and "super-secret" not in text(patch)


def test_diff_between_refs(server) -> None:
    result = call(server, "git.diff", {"from_ref": "HEAD~1", "to_ref": "v1", "patch": True})
    assert "return 2" in text(result) and "secret" not in text(result)
    same = call(server, "git.diff", {"from_ref": "HEAD", "to_ref": "v1"})
    assert "변경 내용이 없습니다" in text(same)


def test_blame_shows_author_per_line(server) -> None:
    result = call(server, "git.blame", {"path": "src/app.py", "start_line": 1, "end_line": 2})
    assert not result.is_error and "Tester" in text(result) and "def alpha" in text(result)


# --------------------------------------------------------------------------- 입력이 새지 않는가


@pytest.mark.parametrize(
    "tool, arguments",
    [
        ("git.read_file", {"path": "README.md", "ref": "--output=pwned.txt"}),
        ("git.log", {"ref": "--all"}),
        ("git.log", {"ref": "-1"}),
        ("git.log", {"ref": "HEAD..main"}),
        ("git.read_file", {"path": "README.md", "ref": "HEAD:README.md"}),
        ("git.diff", {"from_ref": "--stat", "to_ref": "HEAD"}),
        ("git.show_commit", {"commit": "--help"}),
        ("git.read_file", {"path": "../outside.txt"}),
        ("git.read_file", {"path": "src/../../outside.txt"}),
        ("git.read_file", {"path": "/etc/passwd"}),
        ("git.read_file", {"path": "C:/Windows/win.ini"}),
        ("git.read_file", {"path": "-p"}),
        ("git.list_files", {"path": "../"}),
        ("git.search", {"query": "x", "path": "../"}),
    ],
)
def test_hostile_ref_or_path_is_refused_before_git_runs(server, monkeypatch, tool, arguments) -> None:
    def boom(*_a, **_k):
        raise AssertionError("검증 전에 git 을 실행했다")

    monkeypatch.setattr(server, "run_git", boom)
    result = call(server, tool, arguments)
    assert result.is_error and "올바르지 않은" in text(result)


@pytest.mark.parametrize("name", [".env", "config/.env.production", "certs/server.pem", "id_rsa", "deploy/credentials.json", "secrets.yaml"])
def test_secret_looking_files_are_never_read_or_blamed(server, name) -> None:
    assert "읽지 않습니다" in text(call(server, "git.read_file", {"path": name}))
    assert "읽지 않습니다" in text(call(server, "git.blame", {"path": name}))


def test_unregistered_repo_is_refused_and_paths_are_not_accepted_as_names(server, tmp_path: Path) -> None:
    for bad in ("other", str(tmp_path), "../work"):
        result = call(server, "git.list_files", {"repo": bad})
        assert result.is_error and "등록되지 않은 저장소" in text(result)


def test_missing_config_explains_what_to_do(server, tmp_path: Path) -> None:
    server.CONFIG_PATH = tmp_path / "does-not-exist.json"
    result = call(server, "git.list_files")
    assert result.is_error and "repos.example.json" in text(result)


def test_only_read_only_git_subcommands_are_ever_run(server, monkeypatch) -> None:
    """모든 Tool 을 실제로 한 번씩 돌려, git 에 넘긴 하위 명령을 기록해 읽기 전용인지 확인한다."""
    seen: list[str] = []
    real = server.run_git

    def spy(root, args, **kwargs):
        seen.append(args[0])
        return real(root, args, **kwargs)

    monkeypatch.setattr(server, "run_git", spy)
    calls = {
        "git.list_files": {},
        "git.read_file": {"path": "README.md"},
        "git.search": {"query": "alpha"},
        "git.log": {},
        "git.show_commit": {"patch": True},
        "git.diff": {"from_ref": "HEAD~1"},
        "git.blame": {"path": "README.md"},
    }
    for tool, arguments in calls.items():
        assert not call(server, tool, arguments).is_error, tool
    assert set(seen) <= {"ls-tree", "cat-file", "grep", "log", "show", "diff", "blame"}
    assert {"ls-tree", "cat-file", "grep", "log", "show", "diff", "blame"} <= set(seen)


def test_declared_read_only_and_matches_live_schemas(server) -> None:
    manifest = json.loads((SERVER_DIR / "mcp-server-manifest.json").read_text(encoding="utf-8"))
    declared = {t["tool_name"]: t for t in manifest["declared_tools"]}
    live = {t.name: t for t in asyncio.run(server.on_list_tools(None, None)).tools}
    assert set(declared) == set(live)
    for name, tool in declared.items():
        assert tool["risk_level"] == "READ_ONLY"
        assert tool["input_schema"] == server._schema_of(live[name])
        assert live[name].annotations.read_only_hint is True
        assert tool["permissions"]["allowed_roles"] and tool["permissions"]["allowed_orgs"]
