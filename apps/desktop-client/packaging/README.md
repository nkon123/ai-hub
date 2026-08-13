# macOS Developer ID signing and notarization

`pnpm dist:mac` creates arm64 DMG and ZIP artifacts for direct distribution.
The command refuses to build unless all of these prerequisites are present:

- macOS with Xcode command-line tools and `notarytool`
- a valid `Developer ID Application` identity in the login/build keychain
- one complete notarization credential set, supplied as environment variables

Choose exactly one notarization credential mode:

1. App Store Connect API key (recommended for CI):
   `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
2. Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
3. Existing notarytool keychain profile:
   `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`

Never commit certificates, private keys, passwords, API keys, or their real
values. Confirm the production reverse-DNS `appId`, legal author, and copyright
in `package.json` / `electron-builder.yml` before the first release; the current
values are placeholders.

After packaging, verify the generated `.app` (not only the DMG container):

```sh
pnpm verify:mac -- "release/mac-arm64/AI Asset Hub 데스크톱.app"
```

The verifier checks the nested code signature, Gatekeeper assessment, and the
stapled notarization ticket. It does not change Gatekeeper or quarantine state.
