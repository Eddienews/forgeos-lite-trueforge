# Phase 5 Demo Evidence

This file records concise public evidence from the exact documented commands. It contains no provider credentials or raw private logs.

## Environment

- Date: August 26, 2026
- ForgeOS Lite proof commit: `622731f`
- Node.js: 22.23.2
- Git: 2.50.1 (Apple Git-155)
- TrueForge: 0.1.4
- Model: `gpt-5.4-mini`, low reasoning effort
- Temporary root: `/tmp/forgeos-lite`

## Preflight

`npm run demo:check` passed from a clean checkout. It confirmed Node.js, Git, TrueForge, API-key presence without disclosure, short temporary-path suitability, loopback port binding, installed dependencies, and a clean ForgeOS Lite working tree.

## Successful application proof

The exact `npm run demo` command completed in 67.9 seconds.

1. A fresh disposable Git fixture was created at baseline `a5718305ba1b`.
2. The natural-language greeting mission was admitted.
3. The Coordinator displayed the structured objective, one-file scope, Builder actions, validation policies, and Reviewer criteria.
4. A real TrueForge session created the isolated Builder workspace.
5. The model-backed Builder ran the declared transformation.
6. `npm-run-build` and `npm-test` passed in the isolated workspace.
7. The Reviewer approved the exact evidence and scope.
8. Candidate `candidate-c8798e2d-c94c-4353-8f00-2ba48e157865`, abbreviated hash `83bfd25891d9`, affected only `src/greeting.js`.
9. The original fixture remained unchanged before approval.
10. TrueForge emitted the real `tool.approval_required` event.
11. The human entered `APPROVE`; the control plane sent `user.tool_approval: allow` and bound the resulting ApprovalRecord to the exact event.
12. Controlled application changed only `src/greeting.js` to return `Hello from the TrueForge sandbox.`
13. Git `HEAD` remained `a5718305ba1b`.
14. The approval was consumed; no automatic commit or push was created.
15. The TrueForge session, MCP server, connector, Builder workspace, fixture, and temporary service data shut down cleanly.

## Denial proof

The exact `npm run demo:deny` command completed in 41.8 seconds.

- A fresh fixture at baseline `472eff53f188` reached the same real TrueForge approval event after passing Builder, validation, and Reviewer stages.
- The deny response was sent through `user.tool_approval`.
- The candidate was not applied and the project remained unchanged.
- A later allow could not apply because the denied event had no human ApprovalRecord.
- Services, connector, workspaces, fixture, and temporary service data shut down cleanly.

## Repository verification

After review corrections, `npm run verify` passed with 167 tests, the formatting gate, the English-only gate, the lightweight secret check across 55 Git-owned text files, and `npm audit --audit-level=low` reporting zero vulnerabilities.
