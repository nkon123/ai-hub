"""Static Python function signature -> MCP Tool input Schema conversion.

This module deliberately uses :mod:`ast` only. It never imports, compiles,
executes, evaluates annotations, or persists the submitted source. Function
bodies are counted for the transparency report and otherwise discarded.
"""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from typing import Any

MAX_SOURCE_CHARS = 20_000
MAX_PARAMETERS = 64
_TOOL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_IDENTITY_FIELDS = frozenset({"user", "role", "roles", "org", "organization_id"})


class PythonSignatureError(ValueError):
    def __init__(self, reason: str, message: str, *, candidates: list[str] | None = None) -> None:
        super().__init__(message)
        self.reason = reason
        self.candidates = candidates or []


@dataclass(frozen=True)
class PythonSignatureResult:
    function_name: str
    input_schema: dict[str, Any]
    parameters: list[dict[str, Any]]
    discarded: dict[str, Any]
    warnings: list[str]


def _annotation_schema(node: ast.expr | None) -> tuple[dict[str, Any], str]:
    if node is None:
        raise PythonSignatureError(
            "parameter_annotation_missing",
            "모든 파라미터에 타입 표기를 추가하세요. 타입을 추측해 Manifest를 만들지 않습니다.",
        )
    if isinstance(node, ast.Name):
        mapping = {
            "str": ({"type": "string"}, "string"),
            "int": ({"type": "integer"}, "integer"),
            "float": ({"type": "number"}, "number"),
            "bool": ({"type": "boolean"}, "boolean"),
            "Any": ({}, "any"),
        }
        if node.id in mapping:
            return mapping[node.id]
    if isinstance(node, ast.Constant) and node.value is None:
        return {"type": "null"}, "null"
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, left_label = _annotation_schema(node.left)
        right, right_label = _annotation_schema(node.right)
        return {"anyOf": [left, right]}, f"{left_label} | {right_label}"
    if isinstance(node, ast.Subscript):
        base = node.value.id if isinstance(node.value, ast.Name) else None
        args = list(node.slice.elts) if isinstance(node.slice, ast.Tuple) else [node.slice]
        if base in {"list", "List", "set", "Set", "Sequence"} and len(args) == 1:
            item_schema, item_label = _annotation_schema(args[0])
            return {"type": "array", "items": item_schema}, f"array<{item_label}>"
        if base in {"dict", "Dict", "Mapping"} and len(args) == 2:
            key_schema, _ = _annotation_schema(args[0])
            if key_schema.get("type") != "string":
                raise PythonSignatureError(
                    "unsupported_annotation", "dict/Mapping의 키 타입은 str만 지원합니다."
                )
            value_schema, value_label = _annotation_schema(args[1])
            return {
                "type": "object",
                "additionalProperties": value_schema,
            }, f"object<{value_label}>"
        if base == "Optional" and len(args) == 1:
            value_schema, value_label = _annotation_schema(args[0])
            return {"anyOf": [value_schema, {"type": "null"}]}, f"{value_label} | null"
        if base == "Union" and args:
            converted = [_annotation_schema(arg) for arg in args]
            return {"anyOf": [schema for schema, _ in converted]}, " | ".join(
                label for _, label in converted
            )
        if base == "Annotated" and args:
            return _annotation_schema(args[0])
        if base == "Literal" and args:
            try:
                values = [ast.literal_eval(arg) for arg in args]
                json.dumps(values)
            except (ValueError, TypeError):
                raise PythonSignatureError(
                    "unsupported_annotation", "Literal에는 JSON 값만 사용할 수 있습니다."
                ) from None
            return {"enum": values}, "literal"
    raise PythonSignatureError(
        "unsupported_annotation",
        "지원하지 않는 타입 표기입니다. "
        "str/int/float/bool/list/dict/Optional/Union/Literal만 사용하세요.",
    )


def _json_default(node: ast.expr) -> tuple[bool, Any]:
    try:
        value = ast.literal_eval(node)
        json.dumps(value)
        return True, value
    except (ValueError, TypeError):
        return False, None


def convert_python_signature(
    source: str, function_name: str | None = None
) -> PythonSignatureResult:
    if not source.strip():
        raise PythonSignatureError("source_empty", "Python 함수 시그니처를 입력하세요.")
    if len(source) > MAX_SOURCE_CHARS:
        raise PythonSignatureError(
            "source_too_large", f"입력은 {MAX_SOURCE_CHARS:,}자 이하여야 합니다."
        )
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        location = f"{exc.lineno or 1}행 {exc.offset or 1}열"
        raise PythonSignatureError(
            "python_syntax_invalid", f"Python 문법을 해석할 수 없습니다({location})."
        ) from None

    functions = [
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    candidates = [node.name for node in functions]
    if not functions:
        raise PythonSignatureError(
            "function_not_found", "최상위 Python 함수(def 또는 async def)를 찾지 못했습니다."
        )
    if function_name:
        selected = [node for node in functions if node.name == function_name]
        if len(selected) != 1:
            raise PythonSignatureError(
                "function_not_found",
                f"{function_name!r} 함수를 찾지 못했습니다.",
                candidates=candidates,
            )
        function = selected[0]
    elif len(functions) == 1:
        function = functions[0]
    else:
        raise PythonSignatureError(
            "multiple_functions_found",
            "최상위 함수가 여러 개입니다. 변환할 함수 하나만 남겨 다시 시도하세요.",
            candidates=candidates,
        )

    if not _TOOL_NAME.fullmatch(function.name):
        raise PythonSignatureError(
            "function_name_invalid", "함수 이름을 MCP Tool 식별자로 사용할 수 없습니다."
        )
    if function.args.vararg or function.args.kwarg:
        raise PythonSignatureError(
            "variadic_parameters_unsupported",
            "*args와 **kwargs는 입력 Schema로 변환할 수 없습니다.",
        )

    positional = [*function.args.posonlyargs, *function.args.args]
    all_args = [*positional, *function.args.kwonlyargs]
    if len(all_args) > MAX_PARAMETERS:
        raise PythonSignatureError(
            "too_many_parameters", f"파라미터는 최대 {MAX_PARAMETERS}개까지 지원합니다."
        )

    positional_defaults: dict[str, ast.expr] = {}
    if function.args.defaults:
        for arg, default in zip(
            positional[-len(function.args.defaults) :], function.args.defaults, strict=True
        ):
            positional_defaults[arg.arg] = default
    keyword_defaults = {
        arg.arg: default
        for arg, default in zip(function.args.kwonlyargs, function.args.kw_defaults, strict=True)
        if default is not None
    }
    defaults = {**positional_defaults, **keyword_defaults}

    properties: dict[str, Any] = {}
    required: list[str] = []
    parameters: list[dict[str, Any]] = []
    warnings: list[str] = []
    for arg in all_args:
        name = arg.arg
        if name.lower() in _IDENTITY_FIELDS:
            raise PythonSignatureError(
                "identity_parameter_forbidden",
                f"{name!r}은 신원·권한 필드이므로 Tool 입력으로 선언할 수 없습니다. "
                "신원은 Office Profile이 주입합니다.",
            )
        schema, type_label = _annotation_schema(arg.annotation)
        default_included = False
        if name in defaults:
            default_included, default = _json_default(defaults[name])
            if default_included:
                schema = {**schema, "default": default}
            else:
                warnings.append(f"{name}: 호출식/객체 기본값은 실행하지 않고 버렸습니다.")
        else:
            required.append(name)
        properties[name] = schema
        parameters.append(
            {
                "name": name,
                "schema_type": type_label,
                "required": name not in defaults,
                "default_included": default_included,
            }
        )

    docstring_present = ast.get_docstring(function, clean=False) is not None
    discarded_body_count = len(function.body)
    discarded = {
        "body_statement_count": discarded_body_count,
        "decorator_count": len(function.decorator_list),
        "docstring_present": docstring_present,
        "return_annotation_present": function.returns is not None,
        "top_level_statement_count": len(tree.body) - len(functions),
        "source_persisted": False,
        "source_executed": False,
    }
    return PythonSignatureResult(
        function_name=function.name,
        input_schema={
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
        parameters=parameters,
        discarded=discarded,
        warnings=warnings,
    )
