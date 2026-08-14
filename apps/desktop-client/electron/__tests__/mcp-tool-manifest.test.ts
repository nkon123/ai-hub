import { describe, expect, it } from "vitest";
import { parseMcpToolManifest } from "../mcp-tool-manifest";

const manifest = {
  type: "mcp_tool",
  name: " Oracle Tables ",
  server_alias: " oracle-connector ",
  tool_name: " db_metadata.get_tables ",
  risk_level: "READ_ONLY",
  input_schema: { type: "object", properties: {} },
};

describe("parseMcpToolManifest", () => {
  it("maps a read-only manifest to the registration contract and trims identifiers", () => {
    expect(parseMcpToolManifest(manifest)).toMatchObject({
      ok: true,
      serverAlias: "oracle-connector",
      toolName: "db_metadata.get_tables",
      label: "Oracle Tables",
      confirmationPolicy: "NEVER",
    });
  });

  it("maps the boolean execution guard to the strict ALWAYS policy", () => {
    expect(parseMcpToolManifest({ ...manifest, execution_guards: { requires_user_confirmation: true } })).toMatchObject({
      ok: true,
      confirmationPolicy: "ALWAYS",
    });
  });

  it("requires the explicit mcp_tool type and all safety fields", () => {
    expect(parseMcpToolManifest({ ...manifest, type: undefined })).toMatchObject({ ok: false, reason: "manifest_type_mismatch" });
    expect(parseMcpToolManifest({ ...manifest, risk_level: "WRITE" })).toMatchObject({ ok: false, reason: "risk_level_not_read_only" });
    expect(parseMcpToolManifest({ ...manifest, input_schema: undefined })).toMatchObject({ ok: false, reason: "input_schema_missing" });
  });
});
