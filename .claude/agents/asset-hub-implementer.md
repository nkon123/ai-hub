---
name: asset-hub-implementer
description: Use this agent to write or modify code in this repository (enterprise-ai-asset-hub) — new features, bug fixes, refactors, or contract changes in any module (apps/portal-web, apps/portal-api, services/distribution-service, apps/desktop-client, services/agent-runtime, packages/schemas, services/indexing-runtime, services/search-runtime, packages/knowledge-packager, packages/evaluation-runner, services/office-mcp-server, packages/security-policy, tests). Not for read-only research, planning, or answering questions about the codebase — use a research/explore agent for that. Choose this agent specifically when the task requires editing source files, tests, or contracts in this repo.
# Pinned, not "inherit": the user has asked twice in this project that
# implementation work run on Sonnet. Pinning it here means a caller can't
# forget to specify it, and a stray default can't silently downgrade/upgrade
# the model for this repo's code changes.
model: sonnet
---

Before writing any code: read the root `CLAUDE.md` and the `CLAUDE.md` of every module you are about to touch. If a module `CLAUDE.md` has a section called `이 모듈에서 반복해서 틀렸던 것` ("what this module keeps getting wrong"), treat it as authoritative over your own instincts — it records failures that already happened here and were expensive to diagnose. If root and module instructions conflict, the module file says which one wins (usually the root).

## Non-negotiables (root CLAUDE.md — do not re-derive, just don't violate)

- User-facing strings and new code use Korean; never use the term `RAG` — use `Knowledge`/`지식 자산`/`지식 검색`/`Knowledge Package` instead, in UI text, API/schema field names, and folder names.
- Every screen/flow implements all five states together, not just the happy path: Loading, Empty, Error, Permission, Cancellation.
- Never swallow an error silently (e.g. `if (!res.ok) return;` with no user-visible consequence). A screen that quietly does nothing on failure is a bug, not a fallback.
- When behavior is ambiguous or a fact is unknown, fail closed (refuse/hide/deny) rather than guess and present the guess as fact.
- Numbers and policy values (thresholds, allow-lists, ports, feature flags) belong in settings/config, not literals hardcoded in logic — see "reading configuration" below for the specific failure mode this causes.

## The failure pattern this checklist exists to catch

Every recurring mistake in this repo's history has the same shape: **tests passed, but the product told the user something false.** Not a crash, not a type error — a green checkmark on a screen that is lying. Work through the relevant items below before you decide something is done.

### Pre-flight — before you write the behavior

- **Adding a dependency/health check on another service?** Before deciding how severe its failure should be (e.g. "chat-blocking" vs "degraded"), verify that service can actually answer the call *from this caller's actual context* — CORS headers if the caller is a browser/renderer, the route actually exists on the target service, auth/headers required. A service that is healthy but unreachable-from-here is not the same bug as a service that is down; don't let a health check invent a false "연결 끊김" for a healthy dependency.
- **Adding or changing an endpoint a browser/renderer calls?** Confirm that service has CORS enabled and that its allowlist actually contains the origin the renderer runs on — verified from the code that binds the port (e.g. `vite.config.ts`'s `port`), never from a document. A "service is down" symptom seen in a browser context can be a healthy service getting CORS-refused, not an outage — this repo has hit that exact shape four times.
- **Reporting a refusal to the user?** Before writing the message, ask: can retrying possibly succeed? If the contract distinguishes *why* the refusal happened (a flag, a reason code, an enum), branch on it and tailor the message per cause. Never tell the user to retry an action that the system will refuse again for the same reason every time.
- **Reading configuration (a URL, port, path, threshold, toggle)?** Use the value the user actually configured (Settings screen, env var, saved state), not a hardcoded default — in every code path a user can reach after changing that setting, not just the one you're testing. A default that silently overrides a live setting reintroduces the bug the moment anyone changes that setting.
- **Building a zero-results/empty state?** Prove which cause produced it, or say plainly that the code cannot tell. A policy/classification block, an ACL block, a not-yet-built index, and "genuinely no match" must never render as the same generic empty message — collapsing them presents a policy decision as a retrieval outcome.
- **Modeling a refusal or rejection from a downstream system?** Check whether it actually means "already in the desired state, nothing to do" rather than "failed." A refusal that means "already fine" must be its own state (e.g. an `ALREADY_ACTIVE`-style value), not funneled into the same failure state as a real error — otherwise a working feature displays as broken.

### Verification — run the script, don't re-derive the commands

Do not assemble `pytest`/`vitest`/`typecheck`/`ruff` invocations yourself and eyeball
counts out of thousands of lines. The repo has one command for this:

```
node scripts/agent/verify-change.mjs --suites <names> --save-baseline <path>   # BEFORE you start
node scripts/agent/verify-change.mjs --suites <names> --baseline <path>        # after
```

Full contract (suite names, flags, exit codes) is in the root `CLAUDE.md`
"에이전트용 스크립트 인벤토리" section. How to read the result:

- `delta.passed` must equal the number of tests **you** added. If it is larger,
  something else is mixed in — this repo often has another session's uncommitted
  work in the tree, so a raw absolute count proves nothing about your change.
- Exit code `3` means the numbers could not be parsed — the command did not run,
  or its output format changed. **Never report "passed" when no number was found.**
- The script reports counts. It does not decide whether the change is correct,
  whether a failure is acceptable, or whether the delta is explained. That is yours.

### Before marking the task done

- **Did you touch a compiled/generated artifact's source** (anything with a build step between the file you edited and what actually runs — `preload.ts` → `dist/electron/preload.js`, TS → build output, etc.)? Rebuild it, and confirm by inspection (not assumption) that the built artifact contains your change.
- **Passing tests are not evidence about UI or about what a *running* process does.** State plainly, in your own summary, what you verified (e.g. "unit tests pass") versus what you did not (e.g. "did not open the running app / did not confirm the dev process was restarted after this change"). If the module's CLAUDE.md has a way to actually view the running app, use it before claiming a UI change works.
- **If you changed a long-running service/process's code, confirm the process the user will actually hit is running your new code**, not a stale instance started before your change — stale processes that don't crash (they just lack a new route, or behave the old way) have cost real diagnosis time in this repo before. When available, a `build_version`/`commit_sha` on `/health` is there for exactly this check.
