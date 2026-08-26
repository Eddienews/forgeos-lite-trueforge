# Three-Minute Demo Script

## Before recording

Use Node.js 22. From a clean ForgeOS Lite checkout, run `npm install`, `npm test`, and `npm run demo:check`. Keep the terminal large enough to show one stage at a time. Start the recording immediately before `npm run demo`. Do not show the API key or `.env.local`.

## 0:00–0:20 — Problem

Run:

```sh
npm run demo
```

Suggested narration:

> AI coding agents are powerful, but direct access to a real working tree gives autonomy and irreversible authority to the same system. ForgeOS Lite separates those concerns: agents can propose, while a human exclusively authorizes application.

## 0:20–0:45 — Mission

Point to `PROJECT CONNECTED`, the disposable Git revision, and `MISSION RECEIVED`.

Suggested narration:

> This is a real local Git project created fresh for the demo. It has one greeting module and one test. The natural-language mission is simple: update the greeting and keep the tests passing. The original checkout begins clean at this exact commit.

## 0:45–1:30 — Autonomous work

As the Coordinator, Builder, validation, and Reviewer stages appear, briefly point to the files in scope and passing policies.

Suggested narration:

> The Coordinator converts the mission into a bounded public plan; it does not edit. TrueForge creates an isolated workspace and performs the real model-backed Builder execution. ForgeOS Lite permits only the declared build and test policies. The fixed Reviewer then checks the base revision, exact file scope, Builder evidence, candidate identity, and validation results. No hidden reasoning is displayed or trusted.

## 1:30–2:10 — Candidate

Pause on `CANDIDATE PATCH READY`.

Suggested narration:

> The result is a content-addressed CandidatePatch tied to this project, base revision, validation evidence, and Reviewer verdict. The important line is here: original project unchanged. The agents have completed useful work, but none of them has authority to apply it.

## 2:10–2:35 — Human gate

Pause on `AWAITING HUMAN APPROVAL`. Make sure `tool.approval_required` is visible, then type `APPROVE`.

Suggested narration:

> This is a real TrueForge tool approval event, not an application boolean or a pretend yes-or-no prompt. TrueForge has paused the destructive MCP tool call. My terminal action is routed back as `user.tool_approval`, and the approval is bound to this exact session, event, tool call, and reviewed candidate.

## 2:35–2:50 — Apply

Point to `PATCH APPLIED`, the file, unchanged Git `HEAD`, working-tree diff, and consumed approval.

Suggested narration:

> After approval, ForgeOS Lite revalidates the target and applies exactly the reviewed file. Git HEAD is unchanged, the approval is consumed, and the result is an explicit working-tree diff. No commit or push was created automatically.

## 2:50–3:00 — Close

Point to `MISSION COMPLETE` and `CLEAN SHUTDOWN`.

Suggested narration:

> ForgeOS Lite makes autonomous work visible and useful while keeping irreversible authority human. Agents can propose. Humans authorize irreversible changes.

## Optional denial proof

Run `npm run demo:deny`. TrueForge reaches the same real approval event, receives a deny response, leaves the project unchanged, and cannot turn that denied event into an applied candidate. Use this as backup safety evidence rather than part of the primary three-minute recording.
