"""D-034 해석 경로 4: registration of Desktop-installed Agent Packages.

Every test drives the real `LocalAgentRegistry` against a real directory
tree on `tmp_path`, built in the exact shape
`apps/desktop-client/electron/bundle-install.ts` installs into
(`{root}/assets/agents|prompts/{asset_id}/{version}/manifest.json`) — the
validations under test are filesystem/schema decisions, so faking the
filesystem would fake away the thing being tested. No agent-runtime HTTP
server, no LLM, no other service is touched.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agent_runtime.local_agent_registry import (
    AGENT_FOLDER,
    PROMPT_FOLDER,
    LocalAgentRegistrationError,
    LocalAgentRegistry,
)

AGENT_ID = "11111111-1111-4111-8111-111111111111"
PROMPT_ID = "22222222-2222-4222-8222-222222222222"
OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333"
VERSION = "1.0.0"


def _agent_manifest(agent_id: str = AGENT_ID, version: str = VERSION) -> dict:
    return {
        "schema_version": "1.0",
        "id": agent_id,
        "type": "agent",
        "name": "테스트 로컬 Agent",
        "version": version,
        "owner": {"org": "miracom", "team": "platform", "creator_id": "tester@miracom.com"},
        "classification": "PUBLIC_INTERNAL",
        "workflow": {
            "entry_role": "answerer",
            "roles": [
                {
                    "id": "answerer",
                    "type": "answerer",
                    "description": "답변자",
                    "requires_knowledge": True,
                    "requires_mcp": False,
                    "requires_prompt": True,
                }
            ],
        },
        "capabilities": {
            "knowledge_required": True,
            "mcp_allowed": False,
            "streaming": True,
            "citation_required": True,
        },
    }


def _prompt_manifest(prompt_id: str = PROMPT_ID, version: str = VERSION) -> dict:
    return {
        "schema_version": "1.0",
        "id": prompt_id,
        "type": "prompt",
        "name": "테스트 로컬 Prompt",
        "version": version,
        "owner": {"org": "miracom", "team": "platform", "creator_id": "tester@miracom.com"},
        "classification": "PUBLIC_INTERNAL",
        "template": {
            "system": "당신은 테스트 assistant입니다.",
            "file": "template.md",
            "language": "ko",
        },
        "variables": [{"name": "question", "type": "string", "required": True}],
    }


def install_agent_package(
    root: Path,
    *,
    agent_id: str = AGENT_ID,
    agent_version: str = VERSION,
    prompt_id: str = PROMPT_ID,
    prompt_version: str = VERSION,
    agent_manifest: dict | None = None,
    prompt_manifest: dict | None = None,
    write_agent_manifest: bool = True,
    write_prompt_manifest: bool = True,
    agent_manifest_raw: str | None = None,
    write_template: bool = True,
) -> None:
    """Builds one installed Agent Package under `root` in the exact
    `apps/desktop-client` install layout."""
    agent_dir = root / "assets" / AGENT_FOLDER / agent_id / agent_version
    prompt_dir = root / "assets" / PROMPT_FOLDER / prompt_id / prompt_version
    agent_dir.mkdir(parents=True, exist_ok=True)
    prompt_dir.mkdir(parents=True, exist_ok=True)

    if agent_manifest_raw is not None:
        (agent_dir / "manifest.json").write_text(agent_manifest_raw, encoding="utf-8")
    elif write_agent_manifest:
        content = (
            agent_manifest
            if agent_manifest is not None
            else _agent_manifest(agent_id, agent_version)
        )
        (agent_dir / "manifest.json").write_text(json.dumps(content), encoding="utf-8")

    if write_prompt_manifest:
        content = (
            prompt_manifest
            if prompt_manifest is not None
            else _prompt_manifest(prompt_id, prompt_version)
        )
        (prompt_dir / "manifest.json").write_text(json.dumps(content), encoding="utf-8")

    if write_template:
        (prompt_dir / "template.md").write_text("질문: {{question}}", encoding="utf-8")


def make_registry(
    tmp_path: Path, allowed_roots: tuple[str, ...] | None = None
) -> LocalAgentRegistry:
    roots = allowed_roots if allowed_roots is not None else (str(tmp_path / "root"),)
    return LocalAgentRegistry(
        registry_path=tmp_path / "state" / "local-agents.json", allowed_roots=roots
    )


def expect_refusal(fn, reason: str, code: str = "VALIDATION_ERROR") -> None:
    with pytest.raises(LocalAgentRegistrationError) as exc:
        fn()
    assert exc.value.reason == reason
    assert exc.value.code == code


# --- allow-root disabled by default -----------------------------------------


def test_disabled_by_default_and_registration_refused(tmp_path: Path) -> None:
    registry = LocalAgentRegistry(registry_path=tmp_path / "state" / "x.json", allowed_roots=())
    assert registry.enabled is False
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "local_agents_disabled",
        "PERMISSION_DENIED",
    )


def test_disabled_registry_resolve_and_list_are_empty(tmp_path: Path) -> None:
    registry = LocalAgentRegistry(registry_path=tmp_path / "state" / "x.json", allowed_roots=())
    assert registry.resolve(AGENT_ID) is None
    assert registry.list_entries() == []


# --- happy path --------------------------------------------------------


def test_register_then_resolve_and_list(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root)
    registry = make_registry(tmp_path, (str(root),))

    entry = registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION, label="테스트 Agent")
    assert entry.agent_asset_id == AGENT_ID
    assert entry.prompt_asset_id == PROMPT_ID
    assert Path(entry.agent_dir).is_dir()
    assert Path(entry.prompt_dir).is_dir()

    resolved = registry.resolve(AGENT_ID)
    assert resolved is not None
    assert resolved.agent_asset_id == AGENT_ID

    listed = registry.list_entries()
    assert [e.agent_asset_id for e in listed] == [AGENT_ID]


def test_register_is_idempotent_per_agent_asset_id(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root)
    registry = make_registry(tmp_path, (str(root),))
    registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION, label="first")
    entry = registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION, label="second")
    assert entry.label == "second"
    assert len(registry.list_entries()) == 1


def test_unregister(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root)
    registry = make_registry(tmp_path, (str(root),))
    registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION)
    assert registry.unregister(AGENT_ID) is True
    assert registry.resolve(AGENT_ID) is None
    assert registry.unregister(AGENT_ID) is False


def test_list_omits_entries_whose_directory_was_removed_after_registration(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root)
    registry = make_registry(tmp_path, (str(root),))
    registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION)
    import shutil

    shutil.rmtree(root / "assets" / AGENT_FOLDER / AGENT_ID)
    assert registry.list_entries() == []
    assert registry.resolve(AGENT_ID) is None


# --- id/version validation ----------------------------------------------


def test_invalid_agent_asset_id_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register("not-a-uuid", VERSION, PROMPT_ID, VERSION),
        "agent_asset_id_invalid",
    )


def test_invalid_agent_version_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(AGENT_ID, "not-semver", PROMPT_ID, VERSION),
        "agent_version_invalid",
    )


def test_invalid_prompt_asset_id_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, "not-a-uuid", VERSION),
        "prompt_asset_id_invalid",
    )


def test_invalid_prompt_version_is_refused(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, "not-semver"),
        "prompt_version_invalid",
    )


def test_label_too_long_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION, label="x" * 201),
        "label_too_long",
    )


# --- path safety: no field on the request can name a filesystem path -------


def test_path_traversal_style_ids_are_rejected_before_reaching_the_path_layer(
    tmp_path: Path,
) -> None:
    """`agent_asset_id`/`agent_version` are never joined onto a path before
    passing the UUID/semver pattern — a `..`-shaped value never gets far
    enough to matter, but this pins that it is refused as an invalid id,
    not silently traversed."""
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register("../../etc", VERSION, PROMPT_ID, VERSION),
        "agent_asset_id_invalid",
    )


def test_symlink_escaping_the_allowed_root_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    install_agent_package(outside, agent_id=AGENT_ID, agent_version=VERSION)
    # `root/assets/agents/<id>` is a symlink pointing entirely outside the
    # allowed root — this must be refused even though the joined path
    # string itself never contained ".." or an absolute path.
    (root / "assets" / AGENT_FOLDER).mkdir(parents=True, exist_ok=True)
    (root / "assets" / AGENT_FOLDER / AGENT_ID).symlink_to(
        outside / "assets" / AGENT_FOLDER / AGENT_ID, target_is_directory=True
    )
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "path_outside_allowed_roots",
        "PERMISSION_DENIED",
    )


def test_absolute_looking_version_is_rejected_by_the_version_pattern(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    expect_refusal(
        lambda: registry.register(AGENT_ID, "/etc/passwd", PROMPT_ID, VERSION),
        "agent_version_invalid",
    )


# --- installed content missing/invalid --------------------------------------


def test_agent_install_not_found(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir(parents=True, exist_ok=True)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_install_not_found",
    )


def test_prompt_install_not_found(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, write_prompt_manifest=False, write_template=False)
    # Prompt dir itself must not exist for this refusal (only its manifest
    # was skipped above, but mkdir already happened) — remove it fully.
    import shutil

    shutil.rmtree(root / "assets" / PROMPT_FOLDER)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "prompt_install_not_found",
    )


def test_agent_manifest_missing(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, write_agent_manifest=False)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_manifest_missing",
    )


def test_agent_manifest_unreadable(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, agent_manifest_raw="{not valid json")
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_manifest_unreadable",
    )


def test_agent_manifest_schema_invalid(tmp_path: Path) -> None:
    root = tmp_path / "root"
    bad = _agent_manifest()
    del bad["capabilities"]  # required field
    install_agent_package(root, agent_manifest=bad)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_manifest_schema_invalid",
    )


def test_prompt_manifest_schema_invalid(tmp_path: Path) -> None:
    root = tmp_path / "root"
    bad = _prompt_manifest()
    del bad["template"]  # required field
    install_agent_package(root, prompt_manifest=bad)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "prompt_manifest_schema_invalid",
    )


def test_agent_manifest_id_mismatch_is_refused_not_trusted(tmp_path: Path) -> None:
    """D-060 class of bug: the manifest's own `id` disagrees with the id
    the caller asked to register — refused rather than believed."""
    root = tmp_path / "root"
    install_agent_package(root, agent_manifest=_agent_manifest(agent_id=OTHER_AGENT_ID))
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_manifest_id_mismatch",
    )


def test_agent_manifest_version_mismatch_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, agent_manifest=_agent_manifest(version="9.9.9"))
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "agent_manifest_version_mismatch",
    )


def test_prompt_manifest_id_mismatch_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, prompt_manifest=_prompt_manifest(prompt_id=OTHER_AGENT_ID))
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION),
        "prompt_manifest_id_mismatch",
    )


def test_prompt_template_missing(tmp_path: Path) -> None:
    root = tmp_path / "root"
    install_agent_package(root, write_template=False)
    registry = make_registry(tmp_path, (str(root),))
    expect_refusal(
        lambda: registry.register(AGENT_ID, VERSION, PROMPT_ID, VERSION), "prompt_template_missing"
    )
