import { describe, expect, it } from "vitest";
import { parseLocalToolSignature } from "../local-tool-signature";

describe("parseLocalToolSignature", () => {
  it("parses a happy-path function with mixed types and defaults", () => {
    const source = `def lookup_employee(name: str, limit: int = 10, active: bool = True, tags: list[str] = []) -> dict:
    """Look up an employee record."""
    return {}
`;
    const result = parseLocalToolSignature(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.functionName).toBe("lookup_employee");
    expect(result.toolName).toBe("lookup_employee");
    expect(result.inputSchema.type).toBe("object");
    const props = result.inputSchema.properties as Record<string, unknown>;
    expect(props.name).toEqual({ type: "string" });
    expect(props.limit).toEqual({ type: "integer", default: 10 });
    expect(props.active).toEqual({ type: "boolean", default: true });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" }, default: [] });
    expect(result.inputSchema.required).toEqual(["name"]);
    expect(result.parameters).toHaveLength(4);
    expect(result.parameters[0]).toEqual({ name: "name", schemaType: "string", required: true, defaultIncluded: false });
    expect(result.parameters[1].defaultIncluded).toBe(true);
    expect(result.discarded.docstringPresent).toBe(true);
    expect(result.discarded.sourceExecuted).toBe(false);
    expect(result.discarded.sourcePersisted).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("supports Optional/Union/dict/Literal annotations", () => {
    const source = `def f(a: Optional[int], b: Union[str, int], c: dict[str, int], d: Literal["x", "y"]):
    pass
`;
    const result = parseLocalToolSignature(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const props = result.inputSchema.properties as Record<string, unknown>;
    expect(props.a).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(props.b).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(props.c).toEqual({ type: "object", additionalProperties: { type: "integer" } });
    expect(props.d).toEqual({ enum: ["x", "y"] });
  });

  it("rejects a missing type annotation", () => {
    const result = parseLocalToolSignature("def f(a):\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("parameter_annotation_missing");
  });

  it("rejects identity parameter names case-insensitively", () => {
    const result = parseLocalToolSignature("def f(User: str):\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("identity_parameter_forbidden");
  });

  it("rejects *args and **kwargs", () => {
    const varargs = parseLocalToolSignature("def f(*args):\n    pass\n");
    expect(varargs.ok).toBe(false);
    if (!varargs.ok) expect(varargs.reason).toBe("variadic_parameters_unsupported");

    const kwargs = parseLocalToolSignature("def f(**kwargs):\n    pass\n");
    expect(kwargs.ok).toBe(false);
    if (!kwargs.ok) expect(kwargs.reason).toBe("variadic_parameters_unsupported");
  });

  it("reports zero top-level functions as function_not_found", () => {
    const result = parseLocalToolSignature("x = 1\ny = 2\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("function_not_found");
  });

  it("reports multiple top-level functions as multiple_functions_found with candidates", () => {
    const result = parseLocalToolSignature("def a():\n    pass\n\ndef b():\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("multiple_functions_found");
    expect(result.candidates).toEqual(["a", "b"]);
  });

  it("selects a requested function name among several", () => {
    const source = "def a(x: int):\n    pass\n\ndef b(y: str):\n    pass\n";
    const result = parseLocalToolSignature(source, "b");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.functionName).toBe("b");
  });

  it("warns and drops non-JSON default values instead of failing", () => {
    const result = parseLocalToolSignature("def f(x: int = compute_default()):\n    pass\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("x");
    const props = result.inputSchema.properties as Record<string, unknown>;
    expect(props.x).toEqual({ type: "integer" }); // no `default` key attached
    expect(result.inputSchema.required).toEqual([]); // still excluded from required
    expect(result.parameters[0].defaultIncluded).toBe(false);
  });

  it("rejects oversized source", () => {
    const huge = `def f(x: int):\n    pass\n# ${"a".repeat(21_000)}\n`;
    const result = parseLocalToolSignature(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("source_too_large");
  });

  it("rejects empty source", () => {
    const result = parseLocalToolSignature("   \n\t \n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("source_empty");
  });

  it("rejects too many parameters", () => {
    const params = Array.from({ length: 65 }, (_, i) => `p${i}: int`).join(", ");
    const result = parseLocalToolSignature(`def f(${params}):\n    pass\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_many_parameters");
  });

  it("rejects unsupported annotations", () => {
    const result = parseLocalToolSignature("def f(x: SomeCustomClass):\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_annotation");
  });

  it("counts decorators and single-statement bodies", () => {
    const source = "@staticmethod\n@another_decorator\ndef f(x: int):\n    return x\n";
    const result = parseLocalToolSignature(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.discarded.decoratorCount).toBe(2);
    expect(result.discarded.bodyStatementCount).toBe(1);
    expect(result.discarded.docstringPresent).toBe(false);
  });

  it("ignores non-top-level (indented) function definitions", () => {
    const source = "def outer(x: int):\n    def inner(y: int):\n        return y\n    return inner(x)\n";
    const result = parseLocalToolSignature(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.functionName).toBe("outer");
  });

  it("supports async def", () => {
    const result = parseLocalToolSignature("async def f(x: int):\n    return x\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.functionName).toBe("f");
  });
});
