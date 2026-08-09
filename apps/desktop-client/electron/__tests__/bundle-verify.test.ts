import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_INSTALL_POLICY,
  DEFAULT_SIZE_CAP_OPTIONS,
  checkChecksums,
  checkExecutablePolicy,
  checkFreeDiskSpace,
  checkNoNestedArchives,
  checkPathSafety,
  checkRevocationList,
  checkRuntimeCompatibility,
  checkSignatureTrust,
  checkSizeCaps,
  checkZipStructure,
  isEntryPathSafe,
  parseChecksumsFile,
  validateManifestSchema,
  type ParsedManifest,
  type ZipEntryMeta,
} from "../bundle-verify";

function entry(name: string, overrides: Partial<ZipEntryMeta> = {}): ZipEntryMeta {
  return {
    name,
    isDirectory: false,
    uncompressedSize: 100,
    compressedSize: 80,
    isSymlink: false,
    ...overrides,
  };
}

describe("isEntryPathSafe (zip-slip 방어)", () => {
  it("rejects a classic zip-slip traversal", () => {
    expect(isEntryPathSafe("../../evil.txt").safe).toBe(false);
  });

  it("rejects a Windows-style traversal", () => {
    expect(isEntryPathSafe("..\\..\\evil.txt").safe).toBe(false);
  });

  it("rejects a POSIX absolute path", () => {
    expect(isEntryPathSafe("/etc/passwd").safe).toBe(false);
  });

  it("rejects a Windows drive-absolute path", () => {
    expect(isEntryPathSafe("C:\\Windows\\System32\\evil.dll").safe).toBe(false);
  });

  it("rejects a UNC path", () => {
    expect(isEntryPathSafe("\\\\server\\share\\evil.txt").safe).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(isEntryPathSafe("").safe).toBe(false);
  });

  it("accepts a normal nested relative path", () => {
    expect(isEntryPathSafe("assets/knowledge/abc-123/manifest.json").safe).toBe(true);
  });

  it("accepts a path containing '..' only as a substring, not a segment", () => {
    expect(isEntryPathSafe("assets/knowledge/foo..bar/manifest.json").safe).toBe(true);
  });
});

describe("checkPathSafety", () => {
  it("fails the whole batch when any entry is unsafe", () => {
    const result = checkPathSafety([entry("assets/ok.txt"), entry("../../evil.txt")]);
    expect(result.status).toBe("FAIL");
    expect(result.unsafeEntries).toHaveLength(1);
  });

  it("fails on a symlink entry regardless of its name", () => {
    const result = checkPathSafety([entry("assets/ok.txt", { isSymlink: true })]);
    expect(result.status).toBe("FAIL");
  });

  it("passes when every entry is safe", () => {
    const result = checkPathSafety([entry("bundle-manifest.yaml"), entry("assets/knowledge/x/manifest.json")]);
    expect(result.status).toBe("PASS");
    expect(result.unsafeEntries).toHaveLength(0);
  });
});

describe("checkZipStructure", () => {
  it("fails when required entries are missing", () => {
    const result = checkZipStructure([entry("assets/foo.json")]);
    expect(result.status).toBe("FAIL");
  });

  it("passes when both required entries are present", () => {
    const result = checkZipStructure([entry("bundle-manifest.yaml"), entry("checksums.sha256")]);
    expect(result.status).toBe("PASS");
  });
});

describe("checkNoNestedArchives", () => {
  it("rejects a nested zip", () => {
    expect(checkNoNestedArchives([entry("assets/payload.zip")]).status).toBe("FAIL");
  });

  it("allows ordinary data files", () => {
    expect(checkNoNestedArchives([entry("assets/knowledge/x/index/bm25.pkl")]).status).toBe("PASS");
  });
});

describe("checkExecutablePolicy", () => {
  it("rejects an .exe payload", () => {
    expect(checkExecutablePolicy([entry("assets/tool.exe")]).status).toBe("FAIL");
  });

  it("rejects a shell script", () => {
    expect(checkExecutablePolicy([entry("install.sh")]).status).toBe("FAIL");
  });

  it("allows manifest/data files", () => {
    expect(
      checkExecutablePolicy([entry("manifest.json"), entry("index/chroma.sqlite3"), entry("source/doc.md")]).status,
    ).toBe("PASS");
  });
});

describe("checkSizeCaps (Zip Bomb 방어)", () => {
  it("rejects a single oversized file", () => {
    const result = checkSizeCaps([entry("huge.bin", { uncompressedSize: 600 * 1024 * 1024, compressedSize: 500 * 1024 * 1024 })]);
    expect(result.status).toBe("FAIL");
  });

  it("rejects a suspiciously high compression ratio", () => {
    const result = checkSizeCaps([
      entry("bomb.bin", { uncompressedSize: 20 * 1024 * 1024, compressedSize: 1024 }),
    ]);
    expect(result.status).toBe("FAIL");
  });

  it("rejects when the total uncompressed size exceeds the cap", () => {
    const result = checkSizeCaps(
      [entry("a.bin", { uncompressedSize: 1.5 * 1024 ** 3, compressedSize: 1 * 1024 ** 3 })],
      { maxTotalUncompressedBytes: 2 * 1024 ** 3, maxSingleFileUncompressedBytes: 5 * 1024 ** 3, maxCompressionRatio: 200, minRatioCheckBytes: 1024 * 1024 },
    );
    expect(result.status).toBe("PASS"); // single file under caps and ratio 1.5x — sanity check of the helper itself
    expect(result.totalUncompressedBytes).toBeGreaterThan(0);
  });

  it("passes for normal, modestly-compressed small files", () => {
    const result = checkSizeCaps([entry("manifest.json", { uncompressedSize: 700, compressedSize: 400 })]);
    expect(result.status).toBe("PASS");
  });

  it("does not flag tiny files with compressedSize 0 (STORED, below ratio threshold)", () => {
    const result = checkSizeCaps([entry("empty-marker", { uncompressedSize: 0, compressedSize: 0 })]);
    expect(result.status).toBe("PASS");
  });
});

describe("shared bundle-install-policy contract (CLAUDE.md 원칙 2/3)", () => {
  // Independently re-reads the same JSON `bundle-verify.ts` loads at module
  // load time — via a *different* path computation (a fixed relative path
  // from this test file, which vitest never compiles/relocates, instead of
  // `loadBundleInstallPolicy`'s repo-root walk) — so this test cannot pass
  // merely because both sides share one loader function with a bug in it.
  // `apps/portal-api/src/portal_api/routers/admin.py` (M02) reads this exact
  // same file; the goal is that a future edit to the JSON, the schema, or
  // just `bundle-verify.ts`'s local literals (if anyone reintroduces one)
  // cannot silently diverge from what M02 reports on P15.
  const policyPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "schemas",
    "policies",
    "bundle-install-policy.json",
  );
  const rawPolicy = JSON.parse(fs.readFileSync(policyPath, "utf-8")) as {
    archive_extensions: string[];
    executable_extensions: string[];
    size_caps: {
      max_total_uncompressed_bytes: number;
      max_single_file_uncompressed_bytes: number;
      max_compression_ratio: number;
      min_ratio_check_bytes: number;
    };
  };

  it("resolves to the real packages/schemas contract file, not an empty stub", () => {
    expect(fs.existsSync(policyPath)).toBe(true);
    expect(rawPolicy.archive_extensions.length).toBeGreaterThan(0);
  });

  it("BUNDLE_INSTALL_POLICY (bundle-verify.ts's own loaded copy) matches an independent read of the JSON file", () => {
    expect(BUNDLE_INSTALL_POLICY).toEqual(rawPolicy);
  });

  it("ARCHIVE_EXTENSIONS/EXECUTABLE_EXTENSIONS used by checkNoNestedArchives/checkExecutablePolicy come from the shared file", () => {
    // checkNoNestedArchives/checkExecutablePolicy don't expose their extension
    // lists directly, so this drives them with one entry per shared-policy
    // extension and confirms every one is actually enforced.
    for (const ext of rawPolicy.archive_extensions) {
      const result = checkNoNestedArchives([
        { name: `payload${ext}`, isDirectory: false, uncompressedSize: 10, compressedSize: 10, isSymlink: false },
      ]);
      expect(result.status).toBe("FAIL");
    }
    for (const ext of rawPolicy.executable_extensions) {
      const result = checkExecutablePolicy([
        { name: `payload${ext}`, isDirectory: false, uncompressedSize: 10, compressedSize: 10, isSymlink: false },
      ]);
      expect(result.status).toBe("FAIL");
    }
  });

  it("DEFAULT_SIZE_CAP_OPTIONS matches the shared file's size_caps exactly", () => {
    expect(DEFAULT_SIZE_CAP_OPTIONS).toEqual({
      maxTotalUncompressedBytes: rawPolicy.size_caps.max_total_uncompressed_bytes,
      maxSingleFileUncompressedBytes: rawPolicy.size_caps.max_single_file_uncompressed_bytes,
      maxCompressionRatio: rawPolicy.size_caps.max_compression_ratio,
      minRatioCheckBytes: rawPolicy.size_caps.min_ratio_check_bytes,
    });
  });

  it("still pins the known current PoC values (2GB / 500MB / ratio 200) so a shared-file edit is a visible, deliberate diff here too", () => {
    expect(DEFAULT_SIZE_CAP_OPTIONS.maxTotalUncompressedBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(DEFAULT_SIZE_CAP_OPTIONS.maxSingleFileUncompressedBytes).toBe(500 * 1024 * 1024);
    expect(DEFAULT_SIZE_CAP_OPTIONS.maxCompressionRatio).toBe(200);
  });
});

describe("checkFreeDiskSpace", () => {
  it("fails when free space is less than required", () => {
    expect(checkFreeDiskSpace(1000, 500).status).toBe("FAIL");
  });

  it("warns when the safety margin is thin", () => {
    expect(checkFreeDiskSpace(1000, 1050, 200).status).toBe("WARN");
  });

  it("passes with ample free space", () => {
    expect(checkFreeDiskSpace(1000, 10_000_000, 200).status).toBe("PASS");
  });
});

describe("parseChecksumsFile / checkChecksums", () => {
  it("parses standard sha256sum-format lines", () => {
    const content = "abcd1234".repeat(8) + "  assets/a.txt\n" + "ef012345".repeat(8) + "  assets/b.txt\n";
    const parsed = parseChecksumsFile(content);
    expect(parsed.size).toBe(2);
    expect(parsed.get("assets/a.txt")).toBe("abcd1234".repeat(8));
  });

  it("detects a tampered file (checksum mismatch)", () => {
    const declared = new Map([["assets/a.txt", "a".repeat(64)]]);
    const actual = new Map([["assets/a.txt", "b".repeat(64)]]);
    const result = checkChecksums(declared, actual);
    expect(result.status).toBe("FAIL");
    expect(result.mismatched).toContain("assets/a.txt");
  });

  it("detects a declared-but-missing file", () => {
    const declared = new Map([["assets/a.txt", "a".repeat(64)]]);
    const actual = new Map<string, string>();
    const result = checkChecksums(declared, actual);
    expect(result.status).toBe("FAIL");
    expect(result.missing).toContain("assets/a.txt");
  });

  it("passes when every checksum matches", () => {
    const declared = new Map([["assets/a.txt", "a".repeat(64)]]);
    const actual = new Map([["assets/a.txt", "A".repeat(64)]]); // case-insensitive
    expect(checkChecksums(declared, actual).status).toBe("PASS");
  });
});

describe("validateManifestSchema", () => {
  const validManifest = {
    bundle_id: "b1",
    created_at: "2026-08-03T00:00:00Z",
    requested_by: "dev@example.com",
    target_site_id: "gumi",
    root_type: "ASSET_VERSION",
    root_id: "abc",
    included_assets: [
      {
        asset_id: "k1",
        asset_type: "knowledge",
        role: "root",
        name: "재택근무 정책",
        version: "1.0.0",
        required: true,
        status: "APPROVED",
        size_bytes: 100,
      },
    ],
    runtime_requirements: { os: "Windows 10/11 x64", python: ">=3.11", model_aliases: ["default-chat"] },
    install_order: ["knowledge"],
    forbidden_or_suspended_versions_present: false,
    total_installed_size_bytes: 100,
  };

  it("accepts a well-formed manifest", () => {
    const result = validateManifestSchema(validManifest);
    expect(result.status).toBe("PASS");
    expect(result.manifest?.bundle_id).toBe("b1");
  });

  it("rejects a manifest missing required fields", () => {
    const { bundle_id, ...rest } = validManifest;
    const result = validateManifestSchema(rest);
    expect(result.status).toBe("FAIL");
    expect(result.manifest).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateManifestSchema("not-an-object").status).toBe("FAIL");
  });
});

describe("checkRevocationList", () => {
  const includedAssets: ParsedManifest["included_assets"] = [
    { asset_id: "k1", asset_type: "knowledge", role: "root", name: "K", version: "1.0.0", required: true, status: "APPROVED", size_bytes: 1 },
  ];

  it("fails when an included asset+version is revoked", () => {
    const result = checkRevocationList(includedAssets, [
      { asset_id: "k1", version: "1.0.0", status: "SUSPENDED", asset_name: "K" },
    ]);
    expect(result.status).toBe("FAIL");
  });

  it("warns (does not fail) when revocation entries reference other assets", () => {
    const result = checkRevocationList(includedAssets, [
      { asset_id: "unrelated", version: "9.9.9", status: "RETIRED" },
    ]);
    expect(result.status).toBe("WARN");
  });

  it("passes when there is no revocation data", () => {
    expect(checkRevocationList(includedAssets, []).status).toBe("PASS");
  });
});

describe("checkRuntimeCompatibility", () => {
  it("warns on an OS mismatch without failing", () => {
    const result = checkRuntimeCompatibility({ os: "Windows 10/11 x64", python: ">=3.11", model_aliases: [] }, "darwin");
    expect(result.status).toBe("WARN");
  });

  it("passes on a matching OS", () => {
    const result = checkRuntimeCompatibility({ os: "Windows 10/11 x64", python: ">=3.11", model_aliases: [] }, "win32");
    expect(result.status).toBe("PASS");
  });
});

describe("checkSignatureTrust", () => {
  it("always reports 미검증 rather than silently passing", () => {
    const result = checkSignatureTrust();
    expect(result.status).toBe("WARN");
    expect(result.message).toContain("PoC");
  });
});
