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

## ForgeOS Control and generalized real-project gate

The Control and generalized Builder work was aligned by fast-forward to Phase 5 merge commit `9a6dc6299eac274fd7bc6f96a7b081f2d5e349c2` before the following fresh proofs. The environment used Node.js 22.23.2, TrueForge 0.1.4, and `gpt-5.4-mini` with low reasoning effort.

### Fresh Operations Status Dashboard allow proof

`npm run demo:real` generated the runtime-specific values `Northstar Systems F9A6`, `OPS-B5D0CA`, `Atlas API A0`, `Beacon Web E5`, `Cinder Queue DE`, `Delta Storage 69`, and `Elevated response time 1B3B` after process start.

- The Coordinator made zero model calls and emitted the bounded structured plan for `public/**`.
- The real TrueForge Builder completed in one turn without repair.
- The authoritative diff contained `public/app.css`, `public/app.js`, and `public/index.html`.
- `npm-run-build` passed in 6.3 seconds and `npm-test` passed in 7.3 seconds.
- The deterministic Reviewer approved candidate `candidate-709ef0f4-4bf3-458b-8560-fb762f41e189`, abbreviated hash `91672cc2542c`.
- The sealed preview loaded its entry document, CSS, and JavaScript and contained the runtime identifier `OPS-B5D0CA` while the original fixture remained unchanged.
- TrueForge emitted `tool.approval_required`; the human allow response resumed the exact pending tool call.
- Controlled application changed exactly the three candidate files, consumed the approval, and kept target Git `HEAD` at `8648b634b4ff` without a commit or push.
- Runtime and temporary services shut down cleanly after 131.5 seconds.

### Anti-hardcoding and denial proof

A second fresh Operations Status Dashboard run generated different values: `Northstar Systems F7D3`, `OPS-F41DD2`, `Atlas API 48`, `Beacon Web 02`, `Cinder Queue 98`, `Delta Storage FE`, and `Elevated response time FD9A`.

- One Builder turn produced the same bounded three-file inventory with different generated content.
- Build passed in 6.7 seconds, tests passed in 7.8 seconds, and the Reviewer approved.
- Candidate `candidate-6272a9fe-5868-47c2-85dd-5a8bf068c620` had abbreviated hash `587d3e6fff82`, different from the allow proof.
- The preview loaded and verified `OPS-F41DD2` before the real approval event.
- A real deny response left the fixture unchanged, produced no ApprovalRecord, and the proof asserted that the denied event could not later be replayed as allow.
- Cleanup completed after 130.0 seconds.

### Distinct mission generalization proof

The same production Builder path received a reading-list mission containing `Lantern Reading Room 8F42`, `READ-344C47`, categories `Design 5E`, `Systems DF`, and `History E2`, and featured title `The Quiet Index 8F43`.

- The Builder completed in one turn without repair and produced a visibly different application in the same bounded three-file scope.
- Build passed in 7.3 seconds, tests passed in 7.8 seconds, and the Reviewer approved candidate hash `573baa70b4e2`.
- The sealed preview loaded the exact run-specific content before a real deny left the original project unchanged.
- No reading-list special case exists in the production Builder behavior.

### ForgeOS Control visual gate

ForgeOS Control was inspected locally at `http://127.0.0.1:4173/`. Home, Running, Human Approval, Candidate Preview, Changes, Mission Complete, Human Denied, and Runtime Failure states were verified. The final live candidate uses `Northstar Systems 6077` and `OPS-E35F6D`; build passed in 7.7 seconds, tests passed in 8.7 seconds, the Reviewer approved, and candidate hash `734237bd2527` remains stopped at the real `tool.approval_required` event. The preview iframe uses `sandbox="allow-scripts"`, loaded all local assets, and its Degraded filter showed only `Beacon Web EB`. The original disposable project remains clean and unchanged for human review.

### Current repository verification

After alignment and documentation reconciliation, `npm run verify` passed with 179 tests, formatting across 73 files, the English-only gate across 73 files, the lightweight secret check across 72 owned text files, and `npm audit --audit-level=low` reporting zero vulnerabilities. `git diff --check` also passed.

## Pull request 7 review corrections

Qodo's initial review of implementation commit `dc7c19c` reported seven valid findings. The follow-up implementation binds every declared acceptance criterion to an executable immutable check, preserves and retries retained cleanup authority, rolls back partial fixture and preview allocation, distinguishes exhausted validation from runtime failure, and admits deletion only for a tracked non-executable baseline file. Focused regressions cover the executable contract, generated acceptance test, fixture rollback, preview rollback, cleanup retry, validation-failure presentation, and tracked deletion.

After these corrections, `npm run verify` passed with 186 tests, formatting across 73 files, the English-only gate across 73 files, the lightweight secret check across 72 owned text files, and `npm audit --audit-level=low` reporting zero vulnerabilities. The final-head live proof, CI result, Qodo follow-up, and unresolved-thread count remain pull-request gates rather than claims made by this committed document.
