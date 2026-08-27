const root = document.querySelector("#app");
const toast = document.querySelector("[data-toast]");
const token = document.querySelector('meta[name="forgeos-control-token"]').content;
const terminalStates = new Set(["complete", "denied", "validation_failed", "runtime_failed"]);
let state = null;
let selectedTab = "result";
let selectedFile = 0;
let pollTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.method === undefined || options.method === "GET"
        ? {}
        : { "x-forgeos-control-token": token }),
      ...options.headers
    }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "ForgeOS Control request failed.");
  return value;
}

function updateHeader() {
  document.querySelector("[data-project-name]").textContent = state.project.name;
  document.querySelector("[data-project-branch]").textContent = state.project.branch;
  const clean = document.querySelector(".clean-state");
  clean.lastChild.textContent = state.project.clean ? "clean" : "dirty";
  document.querySelector(".header-status").textContent = state.headerStatus;
}

function homeView() {
  return `
    <section class="mission-hero" aria-labelledby="home-title">
      <p class="eyebrow">LOCAL AI CODING HARNESS</p>
      <h1 id="home-title">What would you like to <span class="accent-word">build</span> today?</h1>
      <p class="intro">Describe one focused change. ForgeOS will work in isolation, validate the result, and ask before touching your project.</p>
      <form class="mission-composer" data-action="start-mission">
        <label for="mission">Mission</label>
        <textarea id="mission" name="mission" rows="5" required aria-describedby="mission-help">${escapeHtml(state.mission.suggested)}</textarea>
        <div class="composer-footer">
          <p id="mission-help">Prepared demo project · ${escapeHtml(state.project.type)} · created fresh for every mission</p>
          <button type="submit">Run Mission</button>
        </div>
      </form>
      <p class="safety-note"><span class="safety-shield" aria-hidden="true"></span> Agents can propose. Humans authorize irreversible changes.</p>
    </section>`;
}

function stageSymbol(status) {
  if (status === "passed") return "✓";
  if (status === "failed") return "×";
  if (status === "running") return "●";
  if (status === "action_required") return "!";
  if (status === "denied") return "—";
  return "○";
}

function stageStrip() {
  return `
    <ol class="stage-strip" aria-label="Mission stages">
      ${state.stages
        .map(
          (stage) => `
            <li class="stage stage-${escapeHtml(stage.status)}">
              <span class="stage-symbol" aria-hidden="true">${stageSymbol(stage.status)}</span>
              <span>${escapeHtml(stage.label)}</span>
              <span class="sr-only">${escapeHtml(stage.status.replaceAll("_", " "))}</span>
            </li>`
        )
        .join("")}
    </ol>`;
}

function submittedMission() {
  return `
    <div class="submitted-mission">
      <p class="section-label">MISSION</p>
      <p>${escapeHtml(state.mission.submitted)}</p>
    </div>`;
}

function runningWorkflow() {
  const trueForgeActive = state.latestOutcome?.includes("isolated TrueForge") ?? false;
  const entries = [
    {
      label: "Coordinator",
      status: trueForgeActive ? "running" : "waiting",
      outcome: trueForgeActive ? "Coordinating mission" : "Waiting"
    },
    {
      label: "Builder",
      status: trueForgeActive ? "running" : "waiting",
      outcome: trueForgeActive ? "Running in TrueForge" : "Waiting"
    },
    { label: "Build", status: "waiting", outcome: "Waiting" },
    { label: "Tests", status: "waiting", outcome: "Waiting" },
    { label: "Reviewer", status: "waiting", outcome: "Waiting" }
  ];
  return `
    <div class="workflow-status" aria-label="Verified workflow status">
      ${entries
        .map(
          (entry) => `
            <div class="workflow-row workflow-${entry.status}">
              <strong>${entry.label}</strong>
              <span class="workflow-symbol" aria-hidden="true">${stageSymbol(entry.status)}</span>
              <span>${entry.outcome}</span>
            </div>`
        )
        .join("")}
    </div>`;
}

function runningView() {
  return `
    <section class="workspace" aria-labelledby="running-title">
      ${submittedMission()}
      ${stageStrip()}
      <div class="activity-focus">
        <span class="activity-mark" aria-hidden="true"></span>
        <div>
          <p class="eyebrow">AUTONOMOUS WORK</p>
          <h1 id="running-title">Working in isolation</h1>
          <p class="outcome-copy">${escapeHtml(state.latestOutcome)}</p>
          ${runningWorkflow()}
        </div>
      </div>
      <div class="safety-panel compact">
        <span class="safety-icon" aria-hidden="true">◇</span>
        <div><strong>Your original project is unchanged.</strong><p>Verified results will appear here as they become available.</p></div>
      </div>
    </section>`;
}

function validationRows() {
  if (state.validation.length === 0) return "";
  return `
    <div class="checks" aria-label="Validation checks">
      ${state.validation
        .map(
          (check) => `
            <div class="check-row">
              <span>${check.policyId === "npm-run-build" ? "Build" : "Tests"}</span>
              <span class="check-result ${check.success ? "success" : "failure"}">
                ${check.success ? "✓ Passed" : "× Failed"}${check.duration ? ` · ${escapeHtml(check.duration)}` : ""}
              </span>
            </div>`
        )
        .join("")}
      ${state.reviewer === null ? "" : `<div class="check-row"><span>Reviewer</span><span class="check-result success">✓ ${escapeHtml(state.reviewer.decision === "approved" ? "Approved" : "Rejected")}</span></div>`}
    </div>`;
}

function approvalCandidateSummary() {
  const build = state.validation.find((check) => check.policyId === "npm-run-build");
  const tests = state.validation.find((check) => check.policyId === "npm-test");
  return `
    <div class="approval-summary" aria-label="Candidate summary">
      <div><strong>${state.result?.fileCount ?? 0}</strong><span>${state.result?.fileCount === 1 ? "file changed" : "files changed"}</span></div>
      <div><strong>${build?.success ? "✓" : "—"}</strong><span>Build</span></div>
      <div><strong>${tests?.success ? "✓" : "—"}</strong><span>Tests</span></div>
      <div><strong>${state.reviewer?.decision === "approved" ? "✓" : "—"}</strong><span>Reviewer</span></div>
    </div>`;
}

function approvalGate() {
  if (state.status === "candidate_ready") {
    return `
      <section class="approval-gate preparing" aria-labelledby="approval-title">
        <p class="section-label">HUMAN GATE</p>
        <h2 id="approval-title">Preparing human approval</h2>
        <p>Autonomous work is complete. Apply remains unavailable until TrueForge emits the genuine approval-required event.</p>
        <div class="gate-actions candidate-actions">
          ${state.preview === null ? "" : '<button class="primary-action" type="button" data-tab-target="preview">Preview Candidate</button>'}
          <button class="secondary-button" type="button" data-tab-target="changes">Review Changes</button>
        </div>
      </section>`;
  }
  if (state.status === "approval_required") {
    return `
      <section class="approval-gate required" aria-labelledby="approval-title">
        <p class="section-label action">HUMAN AUTHORITY</p>
        <h2 id="approval-title">Human approval required</h2>
        <p>ForgeOS has finished the autonomous work.</p>
        <div class="approval-result">
          <span>VERIFIED RESULT</span>
          <strong>Mission ready for review</strong>
          <p>${escapeHtml(state.result?.outcome)}</p>
          <code>${escapeHtml(state.result?.affectedFiles.join(", "))}</code>
        </div>
        <strong class="gate-safety">Your original project is still unchanged.</strong>
        <p class="gate-support">Nothing irreversible happens until you decide.</p>
        ${approvalCandidateSummary()}
        <div class="gate-actions">
          ${state.preview === null ? "" : '<button class="secondary-button preview-action" type="button" data-tab-target="preview">Preview Candidate</button>'}
          <button class="secondary-button" type="button" data-tab-target="changes">Review Changes</button>
          <button class="tertiary-button reject-button" type="button" data-decision="deny">Reject</button>
          <button class="primary-action" type="button" data-decision="allow">Apply Changes</button>
        </div>
      </section>`;
  }
  if (state.status === "decision_submitted") {
    const denied = state.approval.state === "deny_submitted";
    return `
      <section class="approval-gate pending" aria-live="polite">
        <p class="section-label">CONTROL PLANE</p>
        <h2>${denied ? "Rejection submitted to TrueForge" : "Approval submitted to TrueForge"}</h2>
        <p>${denied ? "Waiting for the control plane to close the candidate safely." : "Waiting for TrueForge to confirm the exact approval context."}</p>
      </section>`;
  }
  if (state.status === "applying") {
    return `
      <section class="approval-gate pending" aria-live="polite">
        <p class="section-label">CONTROLLED APPLICATION</p>
        <h2>Applying approved changes</h2>
        <p>ForgeOS is validating and applying the exact candidate you approved.</p>
        <div class="micro-status"><span>Approval <strong>confirmed</strong></span><span>Candidate <strong>bound</strong></span><span>Application <strong>running</strong></span></div>
      </section>`;
  }
  return "";
}

function fileSummary() {
  if (state.result === null) return "";
  if (state.status === "complete") {
    return `
      <div class="file-summary complete-file-summary">
        ${state.result.affectedFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}
        <strong>${state.result.fileCount} ${state.result.fileCount === 1 ? "file" : "files"} changed</strong>
      </div>`;
  }
  return `
    <div class="file-summary">
      <strong>${state.result.fileCount} ${state.result.fileCount === 1 ? "file" : "files"} changed</strong>
      ${state.result.affectedFiles.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}
    </div>`;
}

function completionDetails() {
  if (state.status !== "complete") return "";
  return `
    <div class="completion-details" aria-label="Completion evidence">
      <div class="completion-proof">
        <span>Tests <strong>✓ Passed</strong></span>
        <span>Reviewer <strong>✓ Approved</strong></span>
        <span>Human <strong>✓ Approved</strong></span>
      </div>
      <div class="operation-details">
        <span>Git HEAD <strong>unchanged</strong></span>
        <span>Commit <strong>not created</strong></span>
        <span>Push <strong>not performed</strong></span>
      </div>
    </div>`;
}

function planDetails() {
  if (state.plan === null) return "";
  return `
    <details class="plan-details">
      <summary>Plan</summary>
      <dl>
        <div><dt>Objective</dt><dd>${escapeHtml(state.plan.objective)}</dd></div>
        <div><dt>Scope</dt><dd>${state.plan.scope.map((file) => `<code>${escapeHtml(file)}</code>`).join(", ")}</dd></div>
        <div><dt>Builder action</dt><dd>${escapeHtml(state.plan.builderActions.join(" "))}</dd></div>
        <div><dt>Validation</dt><dd>${escapeHtml(state.plan.validationPolicies.join(", "))}</dd></div>
        <div><dt>Reviewer criteria</dt><dd>${escapeHtml(state.plan.reviewerCriteria)}</dd></div>
      </dl>
    </details>`;
}

function resultTab() {
  if (state.failure !== null) {
    const validationFailure = state.status === "validation_failed";
    return `
      <div class="tab-panel" role="tabpanel">
        <div class="failure-summary">
          <p class="section-label">${validationFailure ? "CHECK RESULT" : "MISSION DETAIL"}</p>
          <p class="failure-reason">${escapeHtml(state.failure.summary)}</p>
          ${validationFailure ? "<strong>No candidate was made available for application.</strong>" : ""}
          <strong>${escapeHtml(state.safety.message)}</strong>
        </div>
      </div>`;
  }
  return `
    <div class="tab-panel" role="tabpanel">
      ${state.status === "approval_required" ? "" : approvalGate()}
      ${planDetails()}
    </div>`;
}

function safetyPanel() {
  const approvalWaiting = state.status === "approval_required";
  const primaryMessage = approvalWaiting
    ? "Your original project is still unchanged."
    : state.safety.message;
  return `
    <div class="safety-panel ${state.safety.state === "applied_after_approval" ? "applied" : ""}">
      <span class="safety-icon" aria-hidden="true">◇</span>
      <div>
        <strong>${escapeHtml(primaryMessage)}</strong>
        ${approvalWaiting ? "<p>Nothing irreversible happens until you decide.</p>" : ""}
      </div>
    </div>`;
}

function terminalActions(terminal) {
  if (!terminal) return "";
  if (state.status === "complete") {
    return `
      <div class="terminal-actions">
        ${state.preview === null ? "" : '<button class="primary-action" type="button" data-tab-target="preview">Preview Result</button>'}
        ${selectedTab === "changes" ? '<button class="secondary-button" type="button" data-tab-target="result">Back to Result</button>' : '<button class="secondary-button" type="button" data-tab-target="changes">View Changes</button>'}
        <button class="tertiary-button" type="button" data-action="reset">Start New Mission</button>
      </div>`;
  }
  if (state.status === "denied") {
    return `
      <div class="terminal-actions">
        <button class="secondary-button" type="button" data-tab-target="changes">View Rejected Changes</button>
        <button class="secondary-button" type="button" data-tab-target="timeline">Timeline</button>
        <button class="tertiary-button" type="button" data-action="reset">Start New Mission</button>
      </div>`;
  }
  if (state.status === "validation_failed") {
    return `
      <div class="terminal-actions">
        <button class="secondary-button" type="button" data-tab-target="result">View Checks</button>
        <button class="secondary-button" type="button" data-tab-target="evidence">View Details</button>
        <button class="tertiary-button" type="button" data-action="reset">Start New Mission</button>
      </div>`;
  }
  return `
    <div class="terminal-actions">
      <button class="secondary-button" type="button" data-tab-target="evidence">View Details</button>
      <button class="tertiary-button" type="button" data-action="reset">Start New Mission</button>
    </div>`;
}

function changesActions() {
  const approvalAvailable = state.status === "approval_required";
  return `
    <div class="changes-actions">
      <button class="secondary-button" type="button" data-tab-target="result">Back to Result</button>
      ${state.preview === null ? "" : '<button class="secondary-button" type="button" data-tab-target="preview">Preview Candidate</button>'}
      ${
        approvalAvailable
          ? `<div>
              <button class="tertiary-button reject-button" type="button" data-decision="deny">Reject</button>
              <button class="primary-action" type="button" data-decision="allow">Apply Changes</button>
            </div>`
          : ""
      }
    </div>`;
}

function previewTab() {
  if (state.preview === null) {
    return `<div class="tab-panel empty-panel" role="tabpanel"><p>No isolated candidate preview is available.</p></div>`;
  }
  const applied = state.status === "complete";
  const approvalAvailable = state.status === "approval_required";
  return `
    <div class="tab-panel preview-panel" role="tabpanel">
      <div class="preview-heading">
        <div>
          <p class="section-label">${applied ? "APPLIED RESULT" : "ISOLATED CANDIDATE"}</p>
          <h2>${applied ? "Result preview" : "Candidate preview"}</h2>
          <p>${applied ? "Showing the exact result authorized by the human." : "Running from the isolated candidate."}</p>
        </div>
        <strong>${applied ? "Applied only after human approval." : "Your original project is still unchanged."}</strong>
      </div>
      <div class="preview-frame-shell">
        <iframe
          src="${escapeHtml(state.preview.url)}"
          title="${applied ? "Applied ForgeOS result" : "Isolated ForgeOS candidate preview"}"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
        ></iframe>
      </div>
      <div class="changes-actions preview-actions">
        <button class="secondary-button" type="button" data-tab-target="result">Back to Result</button>
        <button class="secondary-button" type="button" data-tab-target="changes">Review Changes</button>
        ${
          approvalAvailable
            ? `<div>
                <button class="tertiary-button reject-button" type="button" data-decision="deny">Reject</button>
                <button class="primary-action" type="button" data-decision="allow">Apply Changes</button>
              </div>`
            : ""
        }
      </div>
    </div>`;
}

function operationLabel(operation) {
  if (operation === "modify") return "Modified";
  if (operation === "add") return "Added";
  if (operation === "delete") return "Deleted";
  return operation;
}

function changesTab() {
  if (state.changes.length === 0) {
    return `<div class="tab-panel empty-panel" role="tabpanel"><p>No candidate changes are available.</p></div>`;
  }
  const change = state.changes[Math.min(selectedFile, state.changes.length - 1)];
  const multipleFiles = state.changes.length > 1;
  return `
    <div class="tab-panel" role="tabpanel">
      <div class="changes-panel ${multipleFiles ? "multiple-files" : "single-file"}">
        ${
          multipleFiles
            ? `<aside class="file-list" aria-label="Changed files">
                <p class="section-label">FILES · ${state.changes.length}</p>
                ${state.changes.map((item, index) => `<button type="button" class="file-button ${index === selectedFile ? "selected" : ""}" data-file-index="${index}">${escapeHtml(item.path)}</button>`).join("")}
              </aside>`
            : ""
        }
        <section class="diff-view" aria-label="Focused file difference">
          <div class="diff-header"><code>${escapeHtml(change.path)}</code><span>${escapeHtml(operationLabel(change.operation))}</span></div>
          <div class="diff-columns">
            <div><p>Before</p><pre data-diff-before>${escapeHtml(change.before ?? "File did not exist.")}</pre></div>
            <div><p>After</p><pre data-diff-after>${escapeHtml(change.after ?? "File deleted.")}</pre></div>
          </div>
        </section>
      </div>
      ${changesActions()}
    </div>`;
}

function timelineTab() {
  return `
    <div class="tab-panel" role="tabpanel">
      <ol class="timeline-list">
        ${state.timeline.map((item) => `<li class="timeline-${escapeHtml(item.status)}"><span aria-hidden="true">${stageSymbol(item.status)}</span><div><strong>${escapeHtml(item.label)}</strong></div></li>`).join("")}
      </ol>
    </div>`;
}

function evidenceTab() {
  const entries = Object.entries(state.evidence);
  return `
    <div class="tab-panel" role="tabpanel">
      <dl class="evidence-list">
        ${entries.map(([key, value]) => `<div><dt>${escapeHtml(key.replaceAll(/([A-Z])/g, " $1"))}</dt><dd><code>${escapeHtml(Array.isArray(value) ? value.join(", ") : value)}</code></dd></div>`).join("")}
        ${state.cleanup === null ? "" : `<div><dt>Cleanup</dt><dd>${escapeHtml(state.cleanup.status)} · ${escapeHtml(state.cleanup.duration)}</dd></div>`}
      </dl>
    </div>`;
}

function logsTab() {
  return `
    <div class="tab-panel empty-panel" role="tabpanel">
      <p class="section-label">TECHNICAL LOGS</p>
      <p>No raw logs are required to understand this mission. Runtime diagnostics remain bounded and server-side in this first control-surface release.</p>
    </div>`;
}

function tabs() {
  if (!state.tabsAvailable) return "";
  const definitions = [
    ["result", "Result"],
    ["preview", "Preview"],
    ["changes", "Changes"],
    ["timeline", "Timeline"],
    ["evidence", "Evidence"],
    ["logs", "Logs"]
  ];
  const content = {
    result: resultTab,
    preview: previewTab,
    changes: changesTab,
    timeline: timelineTab,
    evidence: evidenceTab,
    logs: logsTab
  }[selectedTab]();
  return `
    <section class="result-navigation">
      <div class="tabs" role="tablist" aria-label="Mission result views">
        ${definitions.map(([id, label]) => `<button type="button" role="tab" aria-selected="${selectedTab === id}" class="tab-button ${selectedTab === id ? "active" : ""}" data-tab-target="${id}">${label}</button>`).join("")}
      </div>
      ${content}
    </section>`;
}

function resultView() {
  const terminal = terminalStates.has(state.status) && state.cleanup?.status === "completed";
  const heading =
    state.status === "runtime_failed"
      ? "ForgeOS could not complete the mission"
      : (state.result?.heading ?? state.headerStatus);
  const outcome = state.failure?.summary ?? state.result?.outcome ?? state.latestOutcome;
  const eyebrow =
    state.status === "complete"
      ? "APPLIED RESULT"
      : state.status === "denied"
        ? "HUMAN DECISION"
        : state.status === "validation_failed"
          ? "VALIDATION"
          : state.status === "runtime_failed"
            ? "MISSION BLOCKED"
            : "VERIFIED RESULT";
  const approvalHero = state.status === "approval_required";
  const labelId = approvalHero ? "approval-title" : "result-title";
  return `
    <section class="workspace result-workspace" aria-labelledby="${labelId}">
      ${submittedMission()}
      ${stageStrip()}
      ${
        approvalHero
          ? `<div class="approval-hero-wrap">${approvalGate()}</div>`
          : `<div class="result-heading">
              <p class="eyebrow">${eyebrow}</p>
              <h1 id="${labelId}">${escapeHtml(heading)}</h1>
              <p class="outcome-copy">${escapeHtml(outcome)}</p>
              ${state.status === "denied" ? '<strong class="denied-proof">Your project was not modified.</strong>' : ""}
              ${fileSummary()}
            </div>
            ${state.status === "complete" ? completionDetails() : validationRows()}
            ${safetyPanel()}`
      }
      ${tabs()}
      ${terminalActions(terminal)}
    </section>`;
}

function render() {
  updateHeader();
  document.body.classList.toggle("is-home", state.status === "home");
  document.body.dataset.state = state.status;
  root.className = state.status === "home" ? "home-shell" : "mission-shell";
  if (state.status === "home") root.innerHTML = homeView();
  else if (state.status === "running") root.innerHTML = runningView();
  else root.innerHTML = resultView();
}

async function refresh() {
  try {
    const next = await api("/api/state");
    if (state === null || next.revision !== state.revision) {
      state = next;
      if (!state.tabsAvailable) selectedTab = "result";
      render();
    }
    emphasizeChangedLines();
  } catch (error) {
    showToast(error.message);
  } finally {
    pollTimer = window.setTimeout(
      refresh,
      state !== null && terminalStates.has(state.status) ? 2000 : 750
    );
  }
}

// Item 14: give changed lines a subtle emphasis so the Before/After diff reads
// at a glance. Purely presentational — derived from the two verified panes.
function emphasizeChangedLines() {
  const before = root.querySelector("[data-diff-before]");
  const after = root.querySelector("[data-diff-after]");
  if (before === null || after === null || before.dataset.emphasized === "true") return;
  before.dataset.emphasized = "true";
  if (before.textContent !== after.textContent) {
    before.classList.add("diff-has-change");
    after.classList.add("diff-has-change");
  }
}

root.addEventListener("submit", async (event) => {
  const form = event.target.closest('[data-action="start-mission"]');
  if (form === null) return;
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    state = await api("/api/missions", {
      method: "POST",
      body: JSON.stringify({ mission: new FormData(form).get("mission") })
    });
    render();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

root.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-tab-target]");
  if (tab !== null) {
    selectedTab = tab.dataset.tabTarget;
    render();
    return;
  }
  const file = event.target.closest("[data-file-index]");
  if (file !== null) {
    selectedFile = Number.parseInt(file.dataset.fileIndex, 10);
    render();
    return;
  }
  const decision = event.target.closest("[data-decision]");
  if (decision !== null) {
    try {
      state = await api("/api/approval", {
        method: "POST",
        body: JSON.stringify({ decision: decision.dataset.decision })
      });
      render();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.closest('[data-action="reset"]') !== null) {
    try {
      state = await api("/api/reset", { method: "POST", body: "{}" });
      selectedTab = "result";
      selectedFile = 0;
      render();
    } catch (error) {
      showToast(error.message);
    }
  }
});

await refresh();
window.addEventListener("beforeunload", () => window.clearTimeout(pollTimer));
