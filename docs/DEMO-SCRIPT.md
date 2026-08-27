# Three-Minute ForgeOS Control Demo Script

## Before recording

Use Node.js 22. From a clean ForgeOS Lite checkout, run `npm install`, `npm run demo:check`, and `npm run verify`. Store `OPENAI_API_KEY` only in the ignored `.env.local` file or the process environment. Never show the key.

Start ForgeOS Control:

```sh
npm run control
```

Open `http://127.0.0.1:4173`. Keep the browser at 1920x1080 or another readable desktop size. The prepared mission generates new company, service, incident, and run identifiers after the process starts.

## 0:00–0:20 — Problem

Show the ForgeOS Control Home and its mission composer.

Suggested narration:

> AI coding agents can be useful without receiving silent authority over a real project. ForgeOS separates autonomous work from irreversible application. Agents can propose. Humans authorize irreversible changes.

## 0:20–0:40 — Mission

Point to the local Git project context and the Operations Status Dashboard mission, then select **Run Mission**.

Suggested narration:

> This is a fresh local Git project. The mission asks for a responsive operations dashboard with run-specific company, service, and incident values. Those values did not exist in ForgeOS source code before this run.

## 0:40–1:20 — Isolated work

Show the verified workflow states as Coordinator planning, Builder work, build, tests, and Reviewer complete.

Suggested narration:

> The Coordinator creates a bounded public plan. A real TrueForge Builder inspects the isolated project and may edit only ordinary text files below public. It has no general shell, package installation, network, commit, or push authority. ForgeOS computes the actual Git diff, runs fixed build and test policies, and allows at most two repair turns. The Reviewer then binds the exact result and evidence to one CandidatePatch.

## 1:20–1:55 — Candidate preview

Open **Preview**. Use the generated application's operational and degraded filter controls.

Suggested narration:

> This is the working candidate, not the original project. It is materialized from the exact reviewed CandidatePatch in a separate read-only preview origin and a sandboxed iframe. The generated filter works, all runtime-specific values are present, and the original project is still unchanged.

## 1:55–2:15 — Exact changes

Open **Changes** and point to `public/index.html`, `public/app.css`, and `public/app.js`, then return to the approval screen.

Suggested narration:

> ForgeOS shows the exact multi-file result before asking for authority. Build, tests, and Reviewer approval are visible, but none of those agents can touch the original project.

## 2:15–2:35 — Human authority

Point to **Human approval required** and the unchanged-project statement. Select **Apply Changes** only after the real approval state is visible.

Suggested narration:

> TrueForge has emitted a real tool approval-required event and paused the destructive MCP tool call. Apply Changes sends the human decision through the existing user tool-approval flow. The browser cannot manufacture an ApprovalRecord or apply a patch by itself.

## 2:35–2:52 — Controlled application

Wait for **Mission complete**, then open **View Changes** or **Preview Result**.

Suggested narration:

> ForgeOS revalidates the clean target, exact base, candidate identity, Reviewer evidence, and single-use approval before applying only the reviewed files. Git HEAD is unchanged. No commit or push was created automatically.

## 2:52–3:00 — Close

Point to the applied result and human-approved evidence.

Suggested narration:

> A user described an idea. TrueForge built it in isolation. ForgeOS made the working result visible, and the real project changed only after explicit human approval.

## Optional safety proofs

- Run `npm run demo:real` for the terminal real-project allow proof.
- Run `npm run forgeos -- real --deny` for a real-project denial proof.
- Run `npm run demo` for the deterministic greeting smoke and regression proof.
- Run `npm run demo:deny` for the deterministic denial and replay proof.

The denial path is a successful safety outcome: the project remains unchanged, no ApprovalRecord is created, and the denied candidate cannot later be replayed as allow.
