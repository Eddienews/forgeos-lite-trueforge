import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMissionJournal,
  createMissionEvent,
  replayMissionJournal,
  validateMissionTransition,
  verifyMissionJournal
} from "../../packages/core/src/index.js";
import { sha256 } from "../../packages/contracts/src/index.js";

const missionId = "mission-1";
const patchHash = "b".repeat(64);
const gitRevision = "a".repeat(40);

function timestamp(index) {
  return new Date(Date.UTC(2026, 7, 26, 4, 0, index)).toISOString();
}

function testEvidence() {
  return [{ kind: "test-run", summary: "Tests passed.", observedAt: timestamp(1) }];
}

const evidenceHash = sha256(testEvidence());

function candidate() {
  return {
    schemaVersion: "1",
    candidateId: "candidate-1",
    missionId,
    projectId: "project-1",
    baseRevision: gitRevision,
    patchPath: "artifacts/candidate.patch",
    patchSha256: patchHash,
    affectedFiles: ["src/index.js"],
    testEvidence: testEvidence(),
    reviewerVerdict: {
      decision: "approved",
      candidateSha256: patchHash,
      evidenceSha256: evidenceHash
    },
    createdAt: timestamp(1)
  };
}

function approval() {
  return {
    schemaVersion: "1",
    approvalId: "approval-1",
    missionId,
    candidateId: "candidate-1",
    projectId: "project-1",
    baseRevision: gitRevision,
    candidateSha256: patchHash,
    reviewerEvidenceSha256: evidenceHash,
    actor: "human",
    decision: "approved",
    createdAt: timestamp(2)
  };
}

function eventInput(index, eventType, payload, actor = "system") {
  return {
    eventId: `event-${index}`,
    missionId,
    eventType,
    actor,
    timestamp: timestamp(index),
    payload
  };
}

function appendLegalLifecycle(journal = new InMemoryMissionJournal()) {
  const transitions = [
    ["draft", "planned", {}],
    ["planned", "approved", {}],
    ["approved", "building", {}],
    ["building", "reviewing", {}],
    ["reviewing", "awaiting_approval", { candidate: candidate() }],
    ["awaiting_approval", "applying", { candidate: candidate(), approval: approval() }],
    [
      "applying",
      "completed",
      {
        applicationEvidence: {
          candidateSha256: patchHash,
          appliedRevision: "d".repeat(40),
          observedAt: timestamp(9)
        }
      }
    ]
  ];
  journal.append(eventInput(1, "mission.created", { state: "draft" }, "human"));
  transitions.forEach(([fromState, toState, evidence], index) => {
    journal.append(
      eventInput(index + 2, "mission.transitioned", { fromState, toState, ...evidence })
    );
  });
  return journal;
}

function appendThroughAwaitingApproval() {
  const journal = new InMemoryMissionJournal();
  journal.append(eventInput(1, "mission.created", { state: "draft" }, "human"));
  const transitions = [
    ["draft", "planned"],
    ["planned", "approved"],
    ["approved", "building"],
    ["building", "reviewing"]
  ];
  transitions.forEach(([fromState, toState], index) => {
    journal.append(eventInput(index + 2, "mission.transitioned", { fromState, toState }));
  });
  journal.append(
    eventInput(6, "mission.transitioned", {
      fromState: "reviewing",
      toState: "awaiting_approval",
      candidate: candidate()
    })
  );
  return journal;
}

function appendThroughApplying() {
  const journal = appendThroughAwaitingApproval();
  journal.append(
    eventInput(7, "mission.transitioned", {
      fromState: "awaiting_approval",
      toState: "applying",
      candidate: candidate(),
      approval: approval()
    })
  );
  return journal;
}

test("replays the complete legal mission lifecycle", () => {
  const journal = appendLegalLifecycle();
  const result = journal.replay({ cachedState: "completed" });
  assert.equal(result.state, "completed");
  assert.equal(result.cacheStatus, "match");
  assert.equal(result.anchor.eventCount, 8);
});

test("rejects illegal state jumps and unknown transitions", () => {
  assert.throws(
    () => validateMissionTransition("draft", { fromState: "draft", toState: "building" }),
    /Illegal mission transition/u
  );
  assert.throws(
    () => validateMissionTransition("draft", { fromState: "draft", toState: "unknown" }),
    /unknown mission state/u
  );
});

test("prevents terminal-state regression", () => {
  assert.throws(
    () => validateMissionTransition("completed", { fromState: "completed", toState: "planned" }),
    /Terminal state/u
  );
  assert.throws(
    () => validateMissionTransition("cancelled", { fromState: "cancelled", toState: "draft" }),
    /Terminal state/u
  );
});

test("requires exact reviewer approval before awaiting human approval", () => {
  const rejected = candidate();
  rejected.reviewerVerdict.decision = "rejected";
  assert.throws(
    () =>
      validateMissionTransition("reviewing", {
        fromState: "reviewing",
        toState: "awaiting_approval",
        candidate: rejected
      }),
    /reviewer approval/u
  );
});

test("requires valid human approval before applying", () => {
  const changedApproval = approval();
  changedApproval.candidateSha256 = "f".repeat(64);
  assert.throws(
    () =>
      validateMissionTransition("awaiting_approval", {
        fromState: "awaiting_approval",
        toState: "applying",
        candidate: candidate(),
        approval: changedApproval
      }),
    /does not match/u
  );
});

test("rejects candidate evidence from another mission", () => {
  const foreignCandidate = { ...candidate(), missionId: "mission-2" };
  assert.throws(
    () =>
      createMissionEvent(
        eventInput(1, "mission.transitioned", {
          fromState: "reviewing",
          toState: "awaiting_approval",
          candidate: foreignCandidate
        })
      ),
    /belongs to a different mission/u
  );
});

test("rejects changing the candidate after entering awaiting approval", () => {
  const changedCandidate = { ...candidate(), affectedFiles: ["src/other.js"] };
  const journal = appendThroughAwaitingApproval();
  assert.throws(
    () =>
      journal.append(
        eventInput(7, "mission.transitioned", {
          fromState: "awaiting_approval",
          toState: "applying",
          candidate: changedCandidate,
          approval: approval()
        })
      ),
    /differs from the candidate awaiting approval/u
  );
});

test("requires structured application evidence before completion", () => {
  assert.throws(
    () => validateMissionTransition("applying", { fromState: "applying", toState: "completed" }),
    /applicationEvidence/u
  );
});

test("binds completion evidence to the applied candidate hash", () => {
  const journal = appendThroughApplying();
  assert.throws(
    () =>
      journal.append(
        eventInput(8, "mission.transitioned", {
          fromState: "applying",
          toState: "completed",
          applicationEvidence: {
            candidateSha256: "f".repeat(64),
            appliedRevision: "d".repeat(40),
            observedAt: timestamp(9)
          }
        })
      ),
    /does not match the applied candidate hash/u
  );
});

test("requires a structured blocked reason and known next actor", () => {
  assert.equal(
    validateMissionTransition("building", {
      fromState: "building",
      toState: "blocked",
      blocked: { code: "test-failed", summary: "Declared tests failed.", nextActor: "builder" }
    }),
    "blocked"
  );
  assert.throws(
    () =>
      validateMissionTransition("building", {
        fromState: "building",
        toState: "blocked",
        blocked: { code: "test-failed", summary: "Declared tests failed.", nextActor: "model" }
      }),
    /nextActor is unknown/u
  );
});

test("does not allow blocked state to bypass lifecycle gates", () => {
  assert.throws(
    () =>
      validateMissionTransition("blocked", {
        fromState: "blocked",
        toState: "awaiting_approval",
        candidate: candidate()
      }),
    /Illegal mission transition/u
  );
});

test("treats exact duplicate event delivery as idempotent", () => {
  const journal = new InMemoryMissionJournal();
  const input = eventInput(1, "mission.created", { state: "draft" }, "human");
  assert.equal(journal.append(input).appended, true);
  assert.equal(journal.append(structuredClone(input)).appended, false);
  assert.equal(journal.events().length, 1);
});

test("rejects event identifier reuse with different content", () => {
  const journal = new InMemoryMissionJournal();
  journal.append(eventInput(1, "mission.created", { state: "draft" }, "human"));
  const collision = eventInput(1, "mission.transitioned", {
    fromState: "draft",
    toState: "planned"
  });
  assert.throws(() => journal.append(collision), /Event identifier collision/u);
});

test("deeply freezes appended events", () => {
  const journal = new InMemoryMissionJournal();
  const result = journal.append(eventInput(1, "mission.created", { state: "draft" }, "human"));
  assert.equal(Object.isFrozen(result.event.payload), true);
  assert.throws(() => {
    result.event.payload.state = "cancelled";
  }, /read only/u);
  assert.equal(journal.replay().state, "draft");
});

test("detects journal deletion against a trusted anchor", () => {
  const journal = appendLegalLifecycle();
  const events = journal.events();
  const anchor = journal.anchor();
  events.pop();
  assert.throws(() => verifyMissionJournal(events, anchor), /trusted anchor/u);
});

test("detects journal reordering", () => {
  const events = appendLegalLifecycle().events();
  [events[2], events[3]] = [events[3], events[2]];
  assert.throws(() => verifyMissionJournal(events), /discontinuous|chain is broken/u);
});

test("detects journal mutation", () => {
  const events = appendLegalLifecycle().events();
  events[1].payload.toState = "cancelled";
  assert.throws(() => verifyMissionJournal(events), /invalid event hash/u);
});

test("detects inserted events", () => {
  const events = appendLegalLifecycle().events();
  const inserted = createMissionEvent(
    eventInput(99, "mission.transitioned", { fromState: "planned", toState: "blocked", blocked: {
      code: "inserted",
      summary: "Unexpected event.",
      nextActor: "human"
    } }),
    events[1]
  );
  events.splice(2, 0, inserted);
  assert.throws(() => verifyMissionJournal(events), /discontinuous|chain is broken/u);
});

test("reports cache divergence without trusting the cache", () => {
  const result = appendLegalLifecycle().replay({ cachedState: "building" });
  assert.equal(result.state, "completed");
  assert.equal(result.cacheStatus, "diverged");
});

test("rejects nested private reasoning in event payloads", () => {
  const journal = new InMemoryMissionJournal();
  assert.throws(
    () =>
      journal.append(
        eventInput(1, "mission.created", {
          state: "draft",
          evidence: { chainOfThought: "private" }
        })
      ),
    /forbidden field/u
  );
});

test("produces deterministic event hashes for canonical payloads", () => {
  const left = createMissionEvent(
    eventInput(1, "mission.transitioned", {
      fromState: "building",
      toState: "blocked",
      blocked: { summary: "Tests failed.", nextActor: "builder", code: "test-failed" }
    })
  );
  const right = createMissionEvent(
    eventInput(1, "mission.transitioned", {
      blocked: { code: "test-failed", nextActor: "builder", summary: "Tests failed." },
      toState: "blocked",
      fromState: "building"
    })
  );
  assert.equal(left.eventHash, right.eventHash);
  const valid = createMissionEvent(eventInput(1, "mission.created", { state: "draft" }));
  assert.equal(replayMissionJournal([valid]).state, "draft");
});
