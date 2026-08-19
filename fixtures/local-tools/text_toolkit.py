"""한 파일에 여러 Tool — `@tool` 다중 등록 샘플.

Desktop 로컬 Tool(D-084)은 파일 하나에 함수가 여럿이면 무엇을 등록할지 알
수 없어 거절한다. `@tool`(또는 `@mcp.tool`)을 붙이면 붙은 것들만 골라 각각
별개 Tool 로 등록한다 — 이 파일은 그 동작을 보여준다. 아래 세 개가 등록되고
`_slugify` 는 데코레이터가 없어 등록되지 않는다.

**여기 있는 `tool` 데코레이터는 이 파일이 스스로 정의한 최소 구현이다.**
실제로는 LangChain(`from langchain_core.tools import tool`)이나 MCP SDK 의
`@mcp.tool` 을 쓴다. 샘플이 외부 의존성 없이(폐쇄망 전제) 그대로 돌게 하려고
직접 정의했고, 원본 함수를 `.func` 에 보관하는 것까지 같은 모양으로 맞췄다
— Desktop 실행기가 래핑된 Tool 을 언랩할 때 보는 곳이 거기다.
"""

import re
import unicodedata


class _Wrapped:
    """호출 불가한 래퍼 — LangChain 의 StructuredTool 과 같은 모양이다."""

    def __init__(self, fn):
        self.func = fn
        self.name = fn.__name__
        self.description = (fn.__doc__ or "").strip()


def tool(fn):
    return _Wrapped(fn)


def _slugify(value: str, ascii_only: bool) -> str:
    # 데코레이터가 없으므로 Tool 로 등록되지 않는다(도우미 함수).
    normalized = unicodedata.normalize("NFKC", value).lower()
    keep = r"[^a-z0-9]+" if ascii_only else r"[^0-9a-z\uac00-\ud7a3]+"
    return re.sub(keep, "-", normalized).strip("-")


@tool
def slugify_title(title: str, ascii_only: bool = False) -> dict:
    """제목을 URL 슬러그로 바꾼다.

    기본은 한글을 남긴다 — 한글 제목에 ascii_only 를 적용하면 슬러그가
    통째로 비어 버려서, 그것을 기본값으로 두면 이 Tool 이 조용히 쓸모없는
    값을 돌려주게 된다. ascii_only 를 켜면 ASCII 만 남기되, 그 때문에 내용이
    사라졌으면 dropped_all 로 알린다.
    """
    slug = _slugify(title, ascii_only)
    return {
        "title": title,
        "slug": slug,
        "ascii_only": ascii_only,
        "dropped_all": slug == "" and title.strip() != "",
    }


@tool
def count_words(text: str, top_n: int = 5) -> dict:
    """단어 빈도를 세어 상위 N개를 돌려준다."""
    words = re.findall(r"[\w']+", text.lower())
    counts: dict[str, int] = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:top_n]
    return {
        "total_words": len(words),
        "unique_words": len(counts),
        "top": [{"word": w, "count": c} for w, c in ranked],
    }


@tool
def mask_digits(text: str, keep_last: int = 4) -> dict:
    """숫자를 가린다 — 계좌·전화번호가 섞인 텍스트를 공유할 때 쓴다.

    keep_last 자리만 남기고 나머지 숫자를 * 로 바꾼다. 원문은 돌려주지
    않는다(가리는 것이 목적인데 원문을 함께 돌려주면 의미가 없다).
    """
    # 숫자 사이의 구분자(-, 공백)를 넘어 "하나의 번호" 로 본다. 조각마다
    # 따로 세면 "110-1234-5678" 처럼 각 조각이 keep_last 이하일 때 아무것도
    # 가려지지 않는다 — 가리는 것이 목적인 Tool 이 안 가리면 없는 것만 못하다.
    pattern = r"\d(?:[\d\s-]*\d)?"

    def _mask(match: "re.Match[str]") -> str:
        run = match.group(0)
        digit_positions = [i for i, ch in enumerate(run) if ch.isdigit()]
        keep = max(0, keep_last)
        masked_upto = len(digit_positions) - keep
        chars = list(run)
        for order, idx in enumerate(digit_positions):
            if order < masked_upto:
                chars[idx] = "*"
        return "".join(chars)

    runs = re.findall(pattern, text)
    return {
        "masked": re.sub(pattern, _mask, text),
        "number_runs": len(runs),
        "keep_last": keep_last,
        "note": "구분자(-, 공백)로 나뉜 숫자도 하나의 번호로 보고 가립니다.",
    }
