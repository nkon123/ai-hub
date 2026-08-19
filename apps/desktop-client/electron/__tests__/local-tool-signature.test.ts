import { describe, expect, it } from "vitest";
import { analyzeLocalToolFile, parseLocalToolSignature } from "../local-tool-signature";

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
    const huge = `def f(x: int):\n    pass\n# ${"a".repeat(201_000)}\n`;
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

  it("mentions @tool as an alternative when refusing multiple undecorated functions", () => {
    const result = parseLocalToolSignature("def a():\n    pass\n\ndef b():\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("@tool");
  });
});

describe("analyzeLocalToolFile", () => {
  it("registers exactly one candidate per @tool-decorated function", () => {
    const source =
      "@tool\n" +
      "def add(a: int, b: int) -> int:\n    return a + b\n\n" +
      "@tool()\n" +
      "def sub(a: int, b: int) -> int:\n    return a - b\n\n" +
      "@mcp.tool(name=\"multiply\")\n" +
      "def mul(a: int, b: int) -> int:\n    return a * b\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectedByDecorator).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((c) => c.ok)).toBe(true);
    expect(result.candidates.map((c) => c.functionName)).toEqual(["add", "sub", "mul"]);
    // Decorator call arguments (`name="multiply"`) are never interpreted —
    // the registered tool name always comes from the function name.
    const mulCandidate = result.candidates[2];
    if (mulCandidate.ok) expect(mulCandidate.toolName).toBe("mul");
  });

  it("recognizes a dotted @mcp.tool decorator without call parens too", () => {
    const source = "@mcp.tool\ndef lookup(name: str) -> str:\n    return name\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectedByDecorator).toBe(true);
    expect(result.candidates).toHaveLength(1);
  });

  it("does not treat an unrelated decorator (e.g. @app.get) as a tool decorator", () => {
    const source = "@app.get(\"/health\")\ndef health():\n    pass\n\n@app.post(\"/x\")\ndef x():\n    pass\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("multiple_functions_found");
  });

  it("falls back to the single-function legacy path when there are no decorators and only one function (no regression)", () => {
    const result = analyzeLocalToolFile("def lookup(name: str) -> str:\n    return name\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selectedByDecorator).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ ok: true, functionName: "lookup" });
  });

  it("refuses multiple undecorated functions with a hint about @tool, unchanged reason", () => {
    const result = analyzeLocalToolFile("def a():\n    pass\n\ndef b():\n    pass\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("multiple_functions_found");
    expect(result.message).toContain("@tool");
    expect(result.candidates).toEqual(["a", "b"]);
  });

  it("registers the valid ones and reports the invalid ones by name+reason when only some @tool functions are valid", () => {
    const source =
      "@tool\n" +
      "def good(x: int) -> int:\n    return x\n\n" +
      "@tool\n" +
      "def bad_missing_annotation(x) -> int:\n    return x\n\n" +
      "@tool\n" +
      "def bad_identity(user: str) -> str:\n    return user\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(3);
    const [good, badAnnotation, badIdentity] = result.candidates;
    expect(good).toMatchObject({ ok: true, functionName: "good" });
    expect(badAnnotation).toMatchObject({
      ok: false,
      functionName: "bad_missing_annotation",
      reason: "parameter_annotation_missing",
    });
    expect(badIdentity).toMatchObject({
      ok: false,
      functionName: "bad_identity",
      reason: "identity_parameter_forbidden",
    });
  });

  it("flags a duplicate function name among selected @tool candidates instead of validating both", () => {
    const source =
      "@tool\ndef dup(x: int) -> int:\n    return x\n\n" +
      "@tool\ndef dup(y: int) -> int:\n    return y * 2\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ ok: true, functionName: "dup" });
    expect(result.candidates[1]).toMatchObject({
      ok: false,
      functionName: "dup",
      reason: "duplicate_function_name_in_file",
    });
  });

  it("still applies every existing safety rule per function (identity params, *args, too many params)", () => {
    const manyParams = Array.from({ length: 65 }, (_, i) => `p${i}: int`).join(", ");
    const source =
      "@tool\ndef variadic(*args):\n    pass\n\n" +
      `@tool\ndef too_many(${manyParams}):\n    pass\n\n` +
      "@tool\ndef ok(x: int) -> int:\n    return x\n";
    const result = analyzeLocalToolFile(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map((c) => c.ok)).toEqual([false, false, true]);
    expect(result.candidates[0]).toMatchObject({ reason: "variadic_parameters_unsupported" });
    expect(result.candidates[1]).toMatchObject({ reason: "too_many_parameters" });
  });

  it("never executes the source — decorator/candidate discovery is regex/text scanning only", () => {
    const source =
      "@tool\ndef f(x: int) -> int:\n    return x\n\n" +
      "# eval/exec/import/subprocess/os.system tokens below must never run:\n" +
      "# eval('1/0')\n";
    expect(() => analyzeLocalToolFile(source)).not.toThrow();
  });

  it("propagates source_empty/source_too_large/function_not_found the same as parseLocalToolSignature", () => {
    expect(analyzeLocalToolFile("   \n").ok).toBe(false);
    const huge = `def f(x: int):\n    pass\n# ${"a".repeat(201_000)}\n`;
    const hugeResult = analyzeLocalToolFile(huge);
    expect(hugeResult.ok).toBe(false);
    if (!hugeResult.ok) expect(hugeResult.reason).toBe("source_too_large");
    const notFoundResult = analyzeLocalToolFile("x = 1\n");
    expect(notFoundResult.ok).toBe(false);
    if (!notFoundResult.ok) expect(notFoundResult.reason).toBe("function_not_found");
  });
});
