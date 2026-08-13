import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`macOS signing preflight failed: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("run pnpm dist:mac on macOS");
}

const notarytool = spawnSync("xcrun", ["notarytool", "--version"], {
  encoding: "utf8",
});
if (notarytool.status !== 0) {
  fail("Xcode notarytool is unavailable; install/select current Xcode command-line tools");
}

const identities = spawnSync(
  "security",
  ["find-identity", "-v", "-p", "codesigning"],
  { encoding: "utf8" },
);
if (
  identities.status !== 0 ||
  !identities.stdout.includes("Developer ID Application:")
) {
  fail("no valid Developer ID Application identity was found in the keychain");
}

const credentialModes = [
  {
    name: "App Store Connect API key",
    variables: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  },
  {
    name: "Apple ID",
    variables: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  },
  {
    name: "notarytool keychain profile",
    variables: ["APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"],
  },
];

const configuredModes = credentialModes.filter(({ variables }) =>
  variables.every((name) => Boolean(process.env[name]?.trim())),
);
const partialModes = credentialModes.filter(({ variables }) => {
  const configured = variables.filter((name) => Boolean(process.env[name]?.trim()));
  return configured.length > 0 && configured.length < variables.length;
});

if (partialModes.length > 0) {
  const descriptions = partialModes
    .map(({ name, variables }) => `${name} (${variables.join(", ")})`)
    .join("; ");
  fail(`incomplete notarization credential set: ${descriptions}`);
}

if (configuredModes.length === 0) {
  fail("configure one notarization credential mode documented in packaging/README.md");
}
if (configuredModes.length > 1) {
  fail("configure exactly one notarization credential mode to avoid ambiguous credentials");
}

console.log(
  `macOS signing preflight passed (${configuredModes[0].name}); secrets were not printed`,
);
