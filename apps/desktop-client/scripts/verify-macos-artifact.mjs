import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`macOS artifact verification failed: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("verification must run on macOS");
}

const inputPath = process.argv[2];
if (!inputPath) {
  fail('pass the generated .app path, for example: pnpm verify:mac -- "release/mac-arm64/AI Asset Hub 데스크톱.app"');
}

const appPath = resolve(inputPath);
if (!appPath.endsWith(".app") || !existsSync(appPath)) {
  fail(`.app bundle not found: ${appPath}`);
}

const checks = [
  {
    label: "code signature",
    command: "codesign",
    args: ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  },
  {
    label: "Gatekeeper assessment",
    command: "spctl",
    args: ["--assess", "--type", "execute", "-vv", appPath],
  },
  {
    label: "stapled notarization ticket",
    command: "xcrun",
    args: ["stapler", "validate", "-v", appPath],
  },
];

for (const { label, command, args } of checks) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) console.log(output);
  if (result.status !== 0) fail(label);
  console.log(`passed: ${label}`);
}

console.log(`verified signed and notarized app: ${appPath}`);
