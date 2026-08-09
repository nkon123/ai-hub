"""System Connector — 05-mcp-security-governance.md §6.

`Connector` is the adapter boundary a real read-only Oracle connector would
implement later (D-014: PoC is Mock-only). Its shape is deliberately the one
§6 specifies:

    health() -> ConnectorStatus
    execute_named_query(query_id, parameters, context) -> rows
    close() -> void

Note there is no `sql: str` parameter anywhere on this interface — "no
arbitrary SQL" is guaranteed *structurally*, not by scrubbing strings: a
caller can only pass a `QueryId` (one of three fixed enum members) plus a
`parameters` dict of already-allowlisted identifiers and prepared values (see
`tools/db_metadata.py` and `tools/table_count.py`, which resolve
schema/table/field/operator against the allowlists below *before* calling
the connector). There is no code path — mock or, later, real — through which
a caller-supplied string could become a SQL fragment, because the interface
never accepts one.

`MockOracleConnector` implements §5's three named queries against a small
fixed in-memory dataset modelling a plausible Korean enterprise interface-log
schema. It never builds or executes SQL of any kind.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from office_mcp_server.request_context import RequestContext


class QueryId(StrEnum):
    GET_TABLES = "get_tables"
    GET_COLUMNS = "get_columns"
    COUNT_WITH_FILTERS = "count_with_filters"


@dataclass(frozen=True)
class ConnectorStatus:
    healthy: bool
    detail: str


class Connector(ABC):
    @abstractmethod
    async def health(self) -> ConnectorStatus: ...

    @abstractmethod
    async def execute_named_query(
        self, query_id: QueryId, parameters: dict, context: RequestContext
    ) -> Any: ...

    @abstractmethod
    async def close(self) -> None: ...


# --------------------------------------------------------------------------
# Allowlists — the security-critical boundary for table_count.query (§5.3)
# and db_metadata.* (§5.1/§5.2). A real connector would source these from
# reviewed Office Profile / connector configuration, never from live DB
# introspection of arbitrary tables.
# --------------------------------------------------------------------------

ALLOWED_SCHEMAS: frozenset[str] = frozenset({"APP"})

ALLOWED_TABLES: dict[str, frozenset[str]] = {
    "APP": frozenset({"INTERFACE_LOG", "BATCH_JOB"}),
}

# field -> comparison allowed for table_count.query filters. Deliberately
# excludes PII-ish / internal columns (e.g. REQUESTER_EMAIL,
# INTERNAL_AUDIT_TOKEN) even though they exist in the mock dataset.
ALLOWED_FILTER_FIELDS: dict[str, frozenset[str]] = {
    "INTERFACE_LOG": frozenset({"STATUS", "INTERFACE_NAME"}),
    "BATCH_JOB": frozenset({"STATUS", "JOB_NAME"}),
}

ALLOWED_OPERATORS: frozenset[str] = frozenset({"eq", "neq"})

MAX_FILTERS = 5

# Columns that exist in the mock dataset but must never be returned by
# db_metadata.get_columns — §9 "금지 Column 제거". A real internal audit
# token column is exactly the kind of thing that must not leak through a
# generic metadata tool.
FORBIDDEN_COLUMNS: dict[str, frozenset[str]] = {
    "INTERFACE_LOG": frozenset({"INTERNAL_AUDIT_TOKEN"}),
    "BATCH_JOB": frozenset(),
}

_TABLE_COMMENTS: dict[str, str] = {
    "INTERFACE_LOG": "인터페이스 처리 이력",
    "BATCH_JOB": "배치 작업 실행 이력",
}

# (name, data_type, nullable, is_primary_key, comment). Note: no "default
# value" field exists anywhere in this shape — §5.2 says a Default Value
# that could be secret/sensitive must not be returned, and the simplest way
# to guarantee that is to never model or expose default values in this tool
# at all (structural, not a per-value redaction decision).
_COLUMNS: dict[str, list[tuple[str, str, bool, bool, str]]] = {
    "INTERFACE_LOG": [
        ("LOG_ID", "NUMBER", False, True, "로그 순번"),
        ("INTERFACE_NAME", "VARCHAR2(100)", False, False, "인터페이스명"),
        ("STATUS", "VARCHAR2(20)", False, False, "처리 상태(SUCCESS/ERROR/PENDING)"),
        ("REQUESTED_AT", "DATE", False, False, "요청 일시"),
        (
            "REQUESTER_EMAIL",
            "VARCHAR2(200)",
            True,
            False,
            "요청자 이메일. 담당자 문의: hong.gildong@miracom.com",
        ),
        ("INTERNAL_AUDIT_TOKEN", "VARCHAR2(64)", True, False, "내부 감사 토큰 - 비공개"),
    ],
    "BATCH_JOB": [
        ("JOB_ID", "NUMBER", False, True, "작업 순번"),
        ("JOB_NAME", "VARCHAR2(100)", False, False, "작업명"),
        ("STATUS", "VARCHAR2(20)", False, False, "실행 상태(SUCCESS/ERROR/RUNNING)"),
        ("RUN_DATE", "DATE", False, False, "실행 일시"),
    ],
}

_ROWS: dict[str, list[dict]] = {
    "INTERFACE_LOG": [
        {"LOG_ID": 1, "INTERFACE_NAME": "HR_SYNC", "STATUS": "SUCCESS"},
        {"LOG_ID": 2, "INTERFACE_NAME": "HR_SYNC", "STATUS": "SUCCESS"},
        {"LOG_ID": 3, "INTERFACE_NAME": "HR_SYNC", "STATUS": "ERROR"},
        {"LOG_ID": 4, "INTERFACE_NAME": "PAYROLL_EXPORT", "STATUS": "SUCCESS"},
        {"LOG_ID": 5, "INTERFACE_NAME": "PAYROLL_EXPORT", "STATUS": "ERROR"},
        {"LOG_ID": 6, "INTERFACE_NAME": "PAYROLL_EXPORT", "STATUS": "PENDING"},
        {"LOG_ID": 7, "INTERFACE_NAME": "ASSET_FEED", "STATUS": "SUCCESS"},
        {"LOG_ID": 8, "INTERFACE_NAME": "ASSET_FEED", "STATUS": "ERROR"},
        {"LOG_ID": 9, "INTERFACE_NAME": "ASSET_FEED", "STATUS": "PENDING"},
        {"LOG_ID": 10, "INTERFACE_NAME": "ASSET_FEED", "STATUS": "PENDING"},
        {"LOG_ID": 11, "INTERFACE_NAME": "VENDOR_SYNC", "STATUS": "SUCCESS"},
        {"LOG_ID": 12, "INTERFACE_NAME": "VENDOR_SYNC", "STATUS": "ERROR"},
    ],
    "BATCH_JOB": [
        {"JOB_ID": 1, "JOB_NAME": "NIGHTLY_CLEANUP", "STATUS": "SUCCESS"},
        {"JOB_ID": 2, "JOB_NAME": "NIGHTLY_CLEANUP", "STATUS": "SUCCESS"},
        {"JOB_ID": 3, "JOB_NAME": "REPORT_BUILD", "STATUS": "ERROR"},
        {"JOB_ID": 4, "JOB_NAME": "REPORT_BUILD", "STATUS": "SUCCESS"},
        {"JOB_ID": 5, "JOB_NAME": "REPORT_BUILD", "STATUS": "RUNNING"},
    ],
}

_OPERATOR_FNS = {
    "eq": lambda actual, expected: actual == expected,
    "neq": lambda actual, expected: actual != expected,
}


class MockOracleConnector(Connector):
    """D-014 PoC Mock. Read-only by construction: this class has no method
    that could mutate `_ROWS`/`_COLUMNS`, and callers never get a reference
    to the module-level dicts (methods return copies)."""

    async def health(self) -> ConnectorStatus:
        return ConnectorStatus(healthy=True, detail="mock oracle connector ready")

    async def execute_named_query(
        self, query_id: QueryId, parameters: dict, context: RequestContext
    ) -> Any:
        if query_id == QueryId.GET_TABLES:
            return self._get_tables(parameters)
        if query_id == QueryId.GET_COLUMNS:
            return self._get_columns(parameters)
        if query_id == QueryId.COUNT_WITH_FILTERS:
            return self._count_with_filters(parameters)
        raise ValueError(f"unknown query_id: {query_id!r}")

    async def close(self) -> None:
        return None

    def _get_tables(self, parameters: dict) -> list[dict]:
        schema = parameters["schema"]
        name_contains = parameters.get("name_contains")
        tables = sorted(ALLOWED_TABLES.get(schema, frozenset()))
        if name_contains:
            tables = [t for t in tables if name_contains.upper() in t]
        return [{"schema": schema, "table": t, "comment": _TABLE_COMMENTS[t]} for t in tables]

    def _get_columns(self, parameters: dict) -> list[dict]:
        table = parameters["table"]
        forbidden = FORBIDDEN_COLUMNS.get(table, frozenset())
        return [
            {
                "name": name,
                "data_type": data_type,
                "nullable": nullable,
                "is_primary_key": is_pk,
                "comment": comment,
            }
            for (name, data_type, nullable, is_pk, comment) in _COLUMNS.get(table, [])
            if name not in forbidden
        ]

    def _count_with_filters(self, parameters: dict) -> int:
        table = parameters["table"]
        filters = parameters.get("filters", [])
        rows = _ROWS.get(table, [])
        count = 0
        for row in rows:
            if all(
                _OPERATOR_FNS[f["operator"]](row.get(f["field"]), f["value"]) for f in filters
            ):
                count += 1
        return count
