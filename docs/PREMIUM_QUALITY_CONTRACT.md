# Premium Quality Contract (draft)

**Status:** Draft — definition artifact (no implementation requirement).  
**Aligns with:** Approved “Soundsible Premium Parity and Superiority Plan” (Approach B, phased gates).  
**Telemetry baseline:** [TELEMETRY_PRIVACY.md](./TELEMETRY_PRIVACY.md) (local-first, Phase 1).  
**Layer boundaries & event catalog:** [LAYER_CONTRACTS.md](./LAYER_CONTRACTS.md).

This contract states **five non-negotiable user outcomes**. Each has a single **pass/fail gate** used to decide whether a phase milestone may ship. Stricter sub-metrics in the phase gate table apply as written there; this page is the **one-page user-outcome summary** for sign-off.

---

## 1. Setup — consumer-grade first play

**Outcome:** A new operator completes guided setup and hears music without editing config files or running ad-hoc shell steps.

**Pass/fail gate:** **≥95%** of setup sessions in a rolling **7-day** window reach **first confirmed playback** within **≤10 minutes** from session start, on the **reference profile** (mid-range laptop, home broadband; no LAN-only assumption). Fail if this drops below target for **two consecutive** measurement checks.

**Measured by:** `setup-events.jsonl` (and equivalent) time-to-`setup_first_play`, with shell-intervention events excluded from the success cohort only when explicitly tagged as operator override (default: any required manual shell = failed session for this gate).

**Blocking phase:** Phase 1 (Premium Baseline).

---

## 2. Migration — trustworthy library transfer

**Outcome:** Imports feel honest: high-confidence matches apply automatically; uncertainty is visible and repairable before the user relies on the library.

**Pass/fail gate:** **≥98%** of imported rows are **exact matches** or **user-confirmed** matches on **reference import fixtures**. Auto-accept only when **match confidence ≥0.90**; below that threshold every row requires **explicit user confirmation** before counting as success.

**Measured by:** Migration audit report per batch (fixture suite + sampled production-shaped imports); `migration-events.jsonl` alignment with audit.

**Blocking phase:** Phase 1 (Premium Baseline).

---

## 3. Playback — uninterrupted, responsive listening

**Outcome:** Playback starts quickly and stays stable enough that routine listening is not disrupted by stalls or queue glitches.

**Pass/fail gate (compound, single outcome):**  
- **Latency:** **p95** `intent_to_playing_ms` **≤350ms** on reference hardware, rolling **7 days**. Fail if regression **>10%** vs frozen baseline.  
- **Continuity:** **≥99.5%** of queue actions complete without critical desync in release-candidate verification. Fail on **any** critical desync bug.  
- **Comfort:** Session **playback stall rate &lt;0.3%** and no pattern of repeated mid-track pauses under standard network profile (operative definition: “no noticeable interruption”).

**Measured by:** `play-timing.jsonl` + playback/queue instrumentation and automated consistency tests.

**Blocking phase:** Phase 2 (Premium Flow).

---

## 4. Discovery — useful, measurable recommendations

**Outcome:** Recommendations justify themselves in use (not only in marketing), with offline quality bar before cohort experiments.

**Pass/fail gate:** **≥40%** of recommended tracks are **played ≥30s** in a rolling **14-day** cohort window, with **measurable uplift vs Phase‑2 baseline** (same cohort methodology). Offline: fixed evaluation dataset passes the **frozen** recommendation quality score with **repeatable** scoring run in CI.

**Measured by:** Layer‑2 reco telemetry (when enabled); offline eval job; uplift vs Phase‑2 baseline per baseline collection plan.

**Blocking phase:** Phase 3 (Premium Intelligence).

---

## 5. Trust — privacy, explanations, and control

**Outcome:** Privacy stays default and invisible in operation; every surfaced recommendation is explainable; users can steer the system without giving up data to third-party ads.

**Pass/fail gate (compound, single outcome):**  
- **Explainability:** **100%** of API responses that return recommendations include a **human-readable reason** string (contract tests per build); **fail** on any missing explanation.  
- **Controls:** **≥50%** of the validation cohort uses **at least one** recommendation control (tune / hide / boost) **and** successfully views reason text within the observation window (**14 days**).  
- **Privacy posture:** Telemetry remains consistent with **TELEMETRY_PRIVACY.md** defaults (local-first, no undisclosed upload); regressions fail the gate regardless of reco metrics.

**Measured by:** API contract tests + UX/reco event logs + privacy contract checklist.

**Blocking phase:** Phase 3–4 boundary: explainability/control gate **blocks Phase 4** until green; privacy compliance is **always** blocking.

---

## Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Product | | | |
| Platform | | | |
| Privacy | | | |

**Change control:** Editing any gate semantics or targets requires bumping **Status** to “Draft” until re-approved and a short changelog note under `docs/`.
