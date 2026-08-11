"""The one and only chokepoint allowed to build hub-bound Knowledge search
query text.

Background: `agent_runtime.workflow.run_knowledge_chat` searches the LOCAL
`search-runtime` (this machine's own offline/loopback Knowledge index) by
default. A separate, opt-in capability lets it additionally query the
CENTRAL hub Knowledge registry through portal-api's
`POST /api/v1/knowledge-search` — a different network/trust boundary than
this machine (`agent_runtime.adapters.hub_search.HttpHubSearchAdapter`).

The security requirement this module exists to enforce: local retrieval
results, local document/chunk text, and any query built from conversation
history must NEVER leave the machine when talking to the hub. In
particular, `agent_runtime.conversation.rewrite_query_for_search` rewrites
the local search query using conversation history, and a prior turn's
*assistant answer* (`ConversationTurn["answer"]`) can legitimately contain
local Knowledge document content — that is what a Knowledge chatbot answer
IS. Building the hub query from that same history (including `["answer"]`
fields), or from the locally-rewritten search query, or from retrieved
citations, would smuggle local document text to the hub.

`build_hub_query` is the ONLY function in this codebase allowed to
construct hub-bound query text, and it reads ONLY:
- this call's `question` parameter (the current turn's raw user-typed text)
- every prior turn's `["question"]` field in `history`

It never reads `["answer"]`, never reads citations, and never reads the
locally-rewritten search query — those simply are not passed in. The
resulting `UserTypedQuery` is a distinct type (not `str`) so that
`agent_runtime.adapters.hub_search.HttpHubSearchAdapter.search` can refuse,
at the type level, anything that was not built here — see that adapter's
`TypeError` guard. This is a real code chokepoint, not just documentation:
see `tests/integration/agent_runtime/test_hub_query.py` for the regression
tests proving `["answer"]` text can never reach it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from agent_runtime.conversation import ConversationTurn


@dataclass(frozen=True)
class UserTypedQuery:
    """Text that is safe to send to the hub (a different network/trust
    boundary than this machine): built ONLY from text the user typed this
    session — this turn's question and prior turns' `["question"]` fields.
    NEVER built from `["answer"]` fields (an assistant answer can
    legitimately contain local Knowledge document content), retrieved
    citations, or the locally-rewritten search query. This type is the
    enforced boundary: see
    `agent_runtime.adapters.hub_search.HttpHubSearchAdapter.search`, which
    raises `TypeError` on anything that isn't this type."""

    text: str


def build_hub_query(question: str, history: Sequence[ConversationTurn]) -> UserTypedQuery:
    """The ONLY function allowed to construct hub-bound query text.

    Reads `turn["question"]` for every turn in `history` and this call's
    `question` parameter — never `turn["answer"]`. Callers must pass the
    ORIGINAL, untouched `question` parameter of `run_knowledge_chat` (the
    current turn's raw user-typed text), not the (possibly LLM-rewritten)
    local search query, and `bounded_history`
    (`agent_runtime.conversation.bound_history`'s output) rather than any
    raw/unbounded history the caller sent.
    """
    parts = [turn["question"] for turn in history]
    parts.append(question)
    text = "\n".join(p.strip() for p in parts if p and p.strip())
    return UserTypedQuery(text=text)
