"""D-094 Policy Enforcement Point 후반 — 호출 **이후**에 적용하는 것.

05-mcp-security-governance.md §9(Output Filter)와 §8.3(결과 상한)을
office-mcp-server 안에서 클라이언트로 옮긴 것이다. 앞의 `policy.py` 가
"호출해도 되는가" 를 정한다면 여기는 "돌아온 것을 그대로 내보내도 되는가" 다.

**서드파티 서버에 이 층이 특히 필요하다.** 우리 서버는 자기 결과를 스스로
필터링하지만, 남이 만든 서버는 그럴 의무가 없다 — 개인정보를 그대로 돌려주는
서버, 수십 MB 를 한 번에 뱉는 서버는 정상적으로 존재한다. 서버를 고칠 수 없으니
받는 쪽에서 막는다.

M10 에서 **옮기지 않은 것 하나**: 금지 Column 제거(`FORBIDDEN_COLUMNS`). 그것은
Oracle 커넥터가 자기 데이터 모델을 알기 때문에 할 수 있는 일이고, 임의의
서드파티 Tool 결과에 일반화할 방법이 없다. office-mcp-server 쪽에 그대로 남으며,
그 서버가 프로토콜로 재노출될 때도 자기 파이프라인 안에서 계속 적용한다 —
이 층은 그 **위에** 얹히는 두 번째 그물이지 대체재가 아니다.

§9 "Masking 전 원본 결과를 일반 로그에 기록하지 않는다" 는 여기서도 지킨다:
이 모듈은 결과 본문을 로그에 남기지 않는다.
"""

from __future__ import annotations

import json
import re
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

#: §9 개인정보 패턴. M10 의 것과 같은 정규식 — 옮기면서 약해지지 않게 그대로 쓴다.
_EMAIL_PATTERN = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_KR_PHONE_PATTERN = re.compile(r"01[016789]-?\d{3,4}-?\d{4}")

#: Tool 이 자기 상한을 선언하지 않았을 때 쓰는 보수적 기본값(§8.3).
DEFAULT_MAX_ROWS = 200
DEFAULT_MAX_BYTES = 262_144
DEFAULT_MAX_FIELD_LENGTH = 2_000


@dataclass(frozen=True)
class ResultLimits:
    max_rows: int = DEFAULT_MAX_ROWS
    max_bytes: int = DEFAULT_MAX_BYTES
    max_field_length: int = DEFAULT_MAX_FIELD_LENGTH

    @classmethod
    def from_execution_guards(cls, guards: dict | None) -> ResultLimits:
        guards = guards or {}
        return cls(
            max_rows=int(guards.get("max_rows") or DEFAULT_MAX_ROWS),
            max_bytes=int(guards.get("max_bytes") or DEFAULT_MAX_BYTES),
            max_field_length=int(guards.get("max_field_length") or DEFAULT_MAX_FIELD_LENGTH),
        )


@dataclass
class FilteredResult:
    """필터를 통과한 결과. SDK 타입을 담지 않는다 — 외부 라이브러리 타입을
    모듈 공개 계약으로 노출하지 않는다(루트 코드 규칙)."""

    content: list[dict] = field(default_factory=list)
    structured_content: Any = None
    truncated: bool = False
    classification: str | None = None
    is_error: bool = False


def mask_pii(value: str) -> str:
    value = _EMAIL_PATTERN.sub("[MASKED_EMAIL]", value)
    value = _KR_PHONE_PATTERN.sub("[MASKED_PHONE]", value)
    return value


def mask_pii_deep(value: object) -> object:
    if isinstance(value, str):
        return mask_pii(value)
    if isinstance(value, list):
        return [mask_pii_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: mask_pii_deep(v) for k, v in value.items()}
    return value


def _truncate_field_strings(item: object, max_len: int) -> tuple[object, bool]:
    if not isinstance(item, dict):
        if isinstance(item, str) and len(item) > max_len:
            return item[:max_len] + "…", True
        return item, False
    truncated = False
    new_item: dict = {}
    for key, value in item.items():
        if isinstance(value, str) and len(value) > max_len:
            new_item[key] = value[:max_len] + "…"
            truncated = True
        else:
            new_item[key] = value
    return new_item, truncated


def _serialized_size(value: Any) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))
    except (TypeError, ValueError):
        return len(str(value).encode("utf-8"))


def apply_result_limits(value: Any, limits: ResultLimits) -> tuple[Any, bool]:
    """§8.3. M10 의 `apply_result_limits` 와 같은 순서 — 행 수 상한 → 문자열
    필드 길이 → 전체 직렬화 크기 재확인 후 추가 절단.

    M10 은 dict 의 top-level 리스트 필드만 다뤘다. MCP 의 `structured_content`
    는 최상위가 리스트일 수도 있어서 그 경우도 처리한다 — 안 하면 서드파티
    서버가 리스트를 그대로 돌려줄 때 상한이 통째로 안 걸린다.
    """
    result = deepcopy(value)
    truncated = False

    def _cap_rows(rows: list) -> tuple[list, bool]:
        changed = False
        if len(rows) > limits.max_rows:
            rows = rows[: limits.max_rows]
            changed = True
        new_rows = []
        for row in rows:
            new_row, field_truncated = _truncate_field_strings(row, limits.max_field_length)
            new_rows.append(new_row)
            changed = changed or field_truncated
        return new_rows, changed

    if isinstance(result, list):
        result, truncated = _cap_rows(result)
    elif isinstance(result, dict):
        for key, item in list(result.items()):
            if isinstance(item, list):
                result[key], changed = _cap_rows(item)
                truncated = truncated or changed
            elif isinstance(item, str) and len(item) > limits.max_field_length:
                result[key] = item[: limits.max_field_length] + "…"
                truncated = True
    elif isinstance(result, str) and len(result) > limits.max_field_length:
        result = result[: limits.max_field_length] + "…"
        truncated = True

    # 크기가 아직 초과면 리스트 꼬리부터 더 잘라낸다. 무한 루프를 막기 위해
    # 리스트가 비면 멈춘다 — 그래도 초과라면 리스트가 아닌 부분이 큰 것이고,
    # 그건 여기서 더 줄일 수 없으므로 truncated 만 정직하게 표시한다.
    if _serialized_size(result) > limits.max_bytes:
        if isinstance(result, list):
            while result and _serialized_size(result) > limits.max_bytes:
                result = result[:-1]
                truncated = True
        elif isinstance(result, dict):
            for key, item in list(result.items()):
                if not isinstance(item, list):
                    continue
                while item and _serialized_size(result) > limits.max_bytes:
                    item = item[:-1]
                    result[key] = item
                    truncated = True
        else:
            truncated = True

    return result, truncated


def _filter_content_block(block: dict, limits: ResultLimits) -> tuple[dict, bool]:
    """Content Block 하나. 텍스트만 마스킹·절단 대상이다 — 이미지/오디오
    바이트를 정규식으로 훑는 것은 의미가 없고, 링크/리소스의 메타데이터는
    그대로 두되 텍스트 필드만 다룬다."""
    out = dict(block)
    truncated = False
    for key in ("text", "description", "title"):
        value = out.get(key)
        if not isinstance(value, str):
            continue
        masked = mask_pii(value)
        if len(masked) > limits.max_field_length:
            masked = masked[: limits.max_field_length] + "…"
            truncated = True
        out[key] = masked
    return out, truncated


def filter_tool_result(
    content: list[dict],
    structured_content: Any = None,
    *,
    limits: ResultLimits | None = None,
    classification: str | None = None,
    is_error: bool = False,
) -> FilteredResult:
    """순서: **마스킹 → 크기 상한** → 등급 라벨.

    **M10 과 의도적으로 다르다.** M10 의 `apply_output_filter` 는 상한을 먼저
    걸고 마스킹을 나중에 하는데, 그 순서에는 실측으로 확인한 누출이 있다
    (2026-09-17): 상한이 이메일 중간을 자르면 남은 조각이 정규식에 걸리지 않아
    로컬 파트가 그대로 남는다 — `"x"*90 + "someone@example.com"` 를
    `max_field_length=100` 으로 처리하면 `...someone@ex…` 가 결과에 남는다.
    마스킹을 먼저 하면 `[MASKED_EMAIL]` 로 치환된 뒤에 잘리므로 남지 않는다.

    M10 이 그 순서를 고른 근거("마스킹은 항상 길이를 줄이거나 같게 하므로
    상한을 다시 깨뜨리지 않는다")도 사실이 아니다 — 짧은 주소는 마스킹이
    **늘린다**(`a@b.co` 6자 → `[MASKED_EMAIL]` 14자). 그래서 여기서는 마스킹
    뒤에 상한을 걸어, 마스킹이 늘렸든 줄였든 최종 크기가 보장되게 한다.
    """
    limits = limits or ResultLimits()

    masked_first = mask_pii_deep(structured_content)
    masked_structured, truncated = apply_result_limits(masked_first, limits)

    filtered_blocks: list[dict] = []
    if len(content) > limits.max_rows:
        content = content[: limits.max_rows]
        truncated = True
    for block in content:
        filtered, block_truncated = _filter_content_block(block, limits)
        filtered_blocks.append(filtered)
        truncated = truncated or block_truncated

    return FilteredResult(
        content=filtered_blocks,
        structured_content=masked_structured,
        truncated=truncated,
        classification=classification,
        is_error=is_error,
    )


def content_blocks_to_dicts(content: Any) -> list[dict]:
    """SDK 의 Content Block 을 평범한 dict 로 옮긴다.

    이 한 함수만 SDK 타입을 안다 — 나머지 필터는 순수 데이터만 다루므로 SDK
    없이도 테스트할 수 있고, SDK 가 필드 이름을 바꿔도 여기만 고치면 된다.
    """
    out: list[dict] = []
    for block in content or []:
        if isinstance(block, dict):
            out.append(block)
            continue
        dump = getattr(block, "model_dump", None)
        out.append(dump(mode="json") if callable(dump) else {"type": "unknown"})
    return out
