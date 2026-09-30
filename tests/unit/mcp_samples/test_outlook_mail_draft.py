"""`samples/mcp-servers/outlook-mail` 의 `outlook.create_draft`.

이 Tool 은 메일을 **보내지 않는다** — 임시 보관함에 저장만 한다. 그 약속과 입력 검증,
그리고 WRITE 로 선언되는지를 고정한다. Outlook(COM)은 필요 없다: 서버가 모듈 수준에
열어 둔 `mailbox_factory` 자리에 가짜를 끼운다.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import sys
from pathlib import Path

import mcp.types as types
import pytest

SERVER_DIR = Path(__file__).resolve().parents[3] / "samples" / "mcp-servers" / "outlook-mail"


@pytest.fixture()
def server():
    spec = importlib.util.spec_from_file_location("outlook_mail_server_under_test", SERVER_DIR / "server.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop(spec.name, None)


class FakeMailItem:
    def __init__(self) -> None:
        self.saved = False
        self.EntryID = "ENTRY-1"

    def Save(self) -> None:  # noqa: N802 — COM 이름
        self.saved = True

    def Send(self) -> None:  # noqa: N802
        raise AssertionError("초안 저장이 메일을 보내려 했다")


class FakeApp:
    def __init__(self) -> None:
        self.item = FakeMailItem()

    def CreateItem(self, kind: int) -> FakeMailItem:  # noqa: N802
        assert kind == 0
        return self.item


class FakeSession:
    def __init__(self, app: FakeApp) -> None:
        self.Application = app


def _mailbox_with_fake(server, app: FakeApp):
    box = server.OutlookMailbox()
    box._session = lambda: FakeSession(app)  # type: ignore[method-assign]
    return box


def _call(server, name: str, arguments: dict) -> types.CallToolResult:
    return asyncio.run(server.on_call_tool(None, types.CallToolRequestParams(name=name, arguments=arguments)))


GOOD = {"to": ["a@example.com"], "subject": "회의 안내", "body": "내일 10시입니다."}


def test_draft_is_saved_and_never_sent(server) -> None:
    app = FakeApp()
    server.mailbox_factory = lambda: _mailbox_with_fake(server, app)
    result = _call(server, "outlook.create_draft", {**GOOD, "cc": ["b@example.com"]})

    assert not result.is_error
    assert app.item.saved is True
    assert app.item.To == "a@example.com"
    assert app.item.CC == "b@example.com"
    assert app.item.Subject == "회의 안내"
    assert result.structured_content["sent"] is False
    assert "보내지 않았습니다" in result.content[0].text


def test_source_has_no_send_call(server) -> None:
    """가짜가 잡지 못하는 경로까지: 소스에 `.Send(` 호출이 없어야 한다(주석·문서 제외)."""
    code_lines = [
        line
        for line in (SERVER_DIR / "server.py").read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("#")
    ]
    offenders = [line for line in code_lines if re.search(r"\.Send\s*\(", line)]
    assert offenders == []


@pytest.mark.parametrize(
    "arguments, fragment",
    [
        ({**GOOD, "to": []}, "to"),
        ({**GOOD, "to": ["not-an-address"]}, "올바르지 않은 이메일"),
        ({**GOOD, "to": ["a@example.com; b@example.com"]}, "올바르지 않은 이메일"),
        ({**GOOD, "to": ["a@example.com\r\nBcc: x@example.com"]}, "올바르지 않은 이메일"),
        ({**GOOD, "cc": ["bad"]}, "올바르지 않은 이메일"),
        ({**GOOD, "subject": "줄\n바꿈"}, "한 줄"),
        ({**GOOD, "subject": "   "}, "한 줄"),
        ({**GOOD, "body": "   "}, "body"),
        ({**GOOD, "to": [f"u{i}@example.com" for i in range(21)]}, "최대"),
    ],
)
def test_invalid_input_is_refused_before_touching_outlook(server, arguments, fragment) -> None:
    def boom():
        raise AssertionError("잘못된 입력인데 Outlook 을 열었다")

    server.mailbox_factory = boom
    result = _call(server, "outlook.create_draft", arguments)
    assert result.is_error
    assert fragment in result.content[0].text


def test_outlook_failure_is_reported_not_raised(server) -> None:
    class Broken(FakeApp):
        def CreateItem(self, kind):  # noqa: N802
            raise OSError("com down")

    server.mailbox_factory = lambda: _mailbox_with_fake(server, Broken())
    result = _call(server, "outlook.create_draft", GOOD)
    assert result.is_error
    assert "초안을 저장하지 못했습니다" in result.content[0].text


def test_declared_as_write_with_confirmation_and_not_read_only(server) -> None:
    manifest = json.loads((SERVER_DIR / "mcp-server-manifest.json").read_text(encoding="utf-8"))
    declared = {t["tool_name"]: t for t in manifest["declared_tools"]}
    draft = declared["outlook.create_draft"]
    assert draft["risk_level"] == "WRITE"
    assert draft["confirmation_policy"] == "ALWAYS"
    assert draft["permissions"]["allowed_roles"] and draft["permissions"]["allowed_orgs"]
    # 읽기 도구는 그대로 읽기 전용이다.
    assert declared["outlook.list_messages"]["risk_level"] == "READ_ONLY"
    assert declared["outlook.get_message"]["risk_level"] == "READ_ONLY"

    tools = {t.name: t for t in asyncio.run(server.on_list_tools(None, None)).tools}
    assert tools["outlook.create_draft"].annotations.read_only_hint is False
    assert tools["outlook.list_messages"].annotations.read_only_hint is True
    assert draft["input_schema"] == server.DRAFT_SCHEMA
