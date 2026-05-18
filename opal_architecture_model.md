# Opal Architecture — Relational Model v1

This model expresses the Opal system architecture as a relational specification before visualization. It includes every component from the original whiteboard diagram plus the components that were previously implicit. Items marked `[new]` are additions beyond the whiteboard.

The model uses a structured declarative format. Each entity has a type, purpose, and explicit input/output/storage relations. Flows are enumerated separately as named pathways with payloads.

---

## 1. Subsystems (top-level groupings)

```
Producer_Side                    # original
Carrier_Side                     # original
Contract_Subsystem               # original
Product_Lookup_Subsystem         # original
Telephony_Subsystem        [new] # was implicit in CRM/Smart_Contact
AI_Enrichment_Subsystem    [new] # was implicit in Smart_Contact
Compliance_Subsystem       [new] # was scattered, now consolidated
Scoring_Engine_Subsystem   [new] # was implied by score artifacts
Identity_Hierarchy_Subsystem [new] # formalizes the producer/agency/carrier topology
```

---

## 2. Components by Subsystem

### 2.1 Producer Side

```
COMPONENT: CRM
  TYPE: UI surface (mission-rendered)
  PURPOSE: Mission-context view of the substrate, rendered per active mission loadout
  PROVIDES: lobby, mission canvases (dial block, sequence builder, etc.), completion screens
  CONSUMES: rendered views from View_Generator
  COMPLIANCE_GATED: yes

COMPONENT: View_Generator
  TYPE: service (stateless renderer)
  PURPOSE: Generates mission-appropriate slices of substrate at request time
  PROVIDES: typed view payloads to CRM
  CONSUMES: user identity, active mission state, Supabase reads
  STORES: nothing (views are computed)

COMPONENT: Contact                                              [renamed from "Smart_Contact"]
  TYPE: entity / data record
  PURPOSE: Lead/prospect substrate object holding all known facts
  STORES: identity, contact info, household, beneficiaries, callback prefs, consent state
  PERSISTED_IN: Supabase

COMPONENT: Enrichment_Service                                   [new — split out of Smart_Contact]
  TYPE: AI pipeline
  PURPOSE: Populates Contact fields from transcripts, notes, lead form data
  PROVIDES: typed field updates with confidence + provenance + source
  CONSUMES: transcript stream, raw lead data, note edits
  STORES: extraction audit log (every field write traceable)

COMPONENT: Supabase
  TYPE: substrate (Postgres + Auth + Realtime + RLS)
  PURPOSE: System of record for the producer-side
  STORES: contacts, calls, transcripts, applications, policies, agents, agencies, missions, audit_log
  ACCESS_CONTROL: row-level security by agent_id and agency_id

COMPONENT: Hierarchy_Constructor
  TYPE: service
  PURPOSE: Resolves agent → agency → business hierarchy at query time
  PROVIDES: hierarchy graph for authorization, rollups, and reporting
  CONSUMES: producer + agency + business records from Supabase

COMPONENT: AMS (Agency Management System)
  TYPE: subsystem
  PURPOSE: Agency admin — commission ledger, hierarchies, business rollups
  CONSUMES: hierarchy from Hierarchy_Constructor, application notifications from eApp
  STORES: agency-level commission ledger, downline performance metrics

COMPONENT: eApp
  TYPE: service
  PURPOSE: Generates and submits carrier-specific applications from substrate
  PROVIDES: complete application payloads to API (carrier-bound)
  CONSUMES: Contact PII, suitability decisions, carrier-specific schemas
  EMITS: new_submission to API; notification to AMS
  COMPLIANCE_GATED: yes (consent verification, suitability check, disclosure record)
```

### 2.2 Telephony Subsystem [new]

```
COMPONENT: Twilio_Bridge
  TYPE: service
  PURPOSE: Outbound dialing, inbound call handling, call leg management
  PROVIDES: dial placement, call legs, recording capture hooks
  CONSUMES: dial queue from active mission (CRM)
  COMPLIANCE_GATED: yes (every dial passes through Compliance_Subsystem first)

COMPONENT: Transcription_Stream
  TYPE: service (Deepgram or equivalent ASR provider)
  PURPOSE: Live ASR during calls
  PROVIDES: streaming transcript to CRM (display) and Enrichment_Service (extraction)
  CONSUMES: audio stream from Twilio_Bridge

COMPONENT: Recording_Store
  TYPE: object storage (S3 or equivalent)
  PURPOSE: Persistent storage of call recordings
  STORES: encrypted audio with metadata (call_id, state, retention class)
  RETENTION: state-aware retention policy

COMPONENT: Call_Outcome_Recorder
  TYPE: service
  PURPOSE: Captures structured disposition from operator and writes to substrate
  PROVIDES: completed call record (outcome, notes, callbacks, AP intent) to Supabase
```

### 2.3 AI Enrichment Subsystem [new]

```
COMPONENT: Transcript_Processor
  TYPE: service
  PURPOSE: Post-call AI pass to extract structured facts from full transcript
  CONSUMES: completed transcript from Transcription_Stream
  PROVIDES: candidate field updates to Enrichment_Service

COMPONENT: Field_Extractor
  TYPE: AI service (Claude API or equivalent)
  PURPOSE: Pulls structured insurance facts (DOB, state, smoker, conditions, meds, beneficiaries, callback prefs, budget)
  PROVIDES: typed field candidates with confidence + source span (transcript line reference)

COMPONENT: Conversation_Summarizer
  TYPE: AI service
  PURPOSE: Generates short summaries for callback context and coaching
  PROVIDES: human-readable summary attached to call record

COMPONENT: Objection_Classifier
  TYPE: AI service
  PURPOSE: Tags objections raised during calls for coaching and aggregate intelligence
  PROVIDES: tagged objection types attached to call record (feeds team-level analytics)
```

### 2.4 Compliance Subsystem [new]

```
COMPONENT: DNC_Service
  TYPE: gate (synchronous)
  PURPOSE: Federal + state DNC list enforcement at dial layer
  CONSUMES: federal DNC list, state DNC lists, internal opt-out records
  PROVIDES: dial_permitted boolean per (phone_number, state)

COMPONENT: Quiet_Hours_Service
  TYPE: gate (synchronous)
  PURPOSE: State-aware quiet hour enforcement
  CONSUMES: contact state/timezone, current time, state-specific rule table
  PROVIDES: dial_permitted boolean

COMPONENT: Recording_Disclosure
  TYPE: service
  PURPOSE: Plays state-specific recording disclosure at call start
  CONSUMES: contact state, call setup event
  PROVIDES: injected disclosure audio at call start
  RECORDS: disclosure-played event in Consent_Ledger

COMPONENT: Consent_Ledger
  TYPE: append-only store
  PURPOSE: Captures and timestamps all consent events (calls, SMS, recording, marketing)
  STORES: consent_type, source, captured_at, expires_at, revoked_at, proof_URL

COMPONENT: Suppression_Engine
  TYPE: gate
  PURPOSE: Cross-channel opt-out enforcement (call, SMS, email)
  CONSUMES: consent state, opt-out events
  PROVIDES: per-channel send permission

COMPONENT: A2P_10DLC_Manager                                    [deferred for v1 — represented for future]
  TYPE: service
  PURPOSE: A2P 10DLC registration + campaign association for SMS
  PROVIDES: registered campaign identity for SMS sends
```

### 2.5 Scoring Engine Subsystem [new]

```
COMPONENT: Opal_Score_Calculator
  TYPE: event-driven service
  PURPOSE: Computes Opal Score per producer from substrate events
  CONSUMES: substrate writes (applications, calls, dispositions, audit events, UW outcomes)
  PROVIDES: producer Opal Score with provenance + component sub-scores
  TRIGGER: real-time on substrate write events; reconciliation nightly

COMPONENT: Producer_Quality_Computer
  TYPE: service
  PURPOSE: Aggregates producer-side quality metrics over rolling windows
  CONSUMES: Opal Score, lapse rates, chargeback history, complaint count, contestable rescissions
  PROVIDES: rolling Producer_Quality metric (consumed by Carrier_Ranking and Contract_Decision)

COMPONENT: Carrier_Quality_Computer
  TYPE: service
  PURPOSE: Aggregates carrier-side quality metrics over rolling windows
  CONSUMES: underwriting decision speed, approval rates, post-issue stability, complaint volume
  PROVIDES: rolling Carrier_Quality metric (consumed by Product_Lookup and Producer Side views)

COMPONENT: UW_Score_Tracker
  TYPE: service
  PURPOSE: Tracks underwriting outcome per application as decisions are made
  CONSUMES: carrier-side decision events, policy state changes
  PROVIDES: per-application UW score; feeds back into Opal_Score_Calculator

COMPONENT: Score_Audit_Log
  TYPE: append-only store
  PURPOSE: Immutable record of every score computation
  STORES: score event, inputs at compute time, factor weights at compute time, output value
  RATIONALE: enables defensible explanation when a score is challenged (regulatory, producer dispute, carrier audit)
```

### 2.6 Product Lookup Subsystem

```
COMPONENT: Product_List
  TYPE: catalog
  PURPOSE: Current set of available products across integrated carriers
  STORES: product metadata, eligibility rules, commission terms, carrier_id

COMPONENT: Comp_Computer
  TYPE: service
  PURPOSE: Comparative pricing/eligibility across products for a specific prospect
  CONSUMES: Contact facts, Product_List, carrier underwriting rules
  PROVIDES: ranked product candidates with quotes

COMPONENT: Contracts_Viewer
  TYPE: UI surface
  PURPOSE: Shows producer their current carrier appointments and contracting status
  CONSUMES: Contract_dB, Producer_Quality

COMPONENT: Carrier_Ranking
  TYPE: service
  PURPOSE: Ranks carriers for a specific (prospect, producer) combination
  CONSUMES: Carrier_Quality, Producer_Quality, prospect facts
  PROVIDES: ranked carrier list for product surfacing in CRM product bay
```

### 2.7 Carrier Side

```
COMPONENT: Router
  TYPE: service
  PURPOSE: Routes new applications to instant decision or HIL underwriting
  CONSUMES: new_submission from API, Opal Score from Scoring Engine, carrier routing rules
  PROVIDES: routing decision (auto-decision / human-review / decline-upfront)

COMPONENT: Instant_Decision_Engine
  TYPE: service
  PURPOSE: Auto-underwrites applications meeting straight-through criteria
  CONSUMES: application payload + Opal Score + carrier rules + MIB/Rx checks
  PROVIDES: underwriting decision (approve / decline / refer-to-human)

COMPONENT: HIL_Underwriting
  TYPE: workflow tool (UX for carrier humans)                  [architectural commitment]
  PURPOSE: Human underwriter workflow for non-straight-through cases
  PROVIDES: underwriting decision with audit trail
  NOTE: This is carrier-facing UX. Opal provides UI to carrier employees, not just APIs.

COMPONENT: Policy_Book
  TYPE: store
  PURPOSE: System of record for in-force policies on carrier side
  STORES: policy state, premiums, beneficiaries, change history

COMPONENT: Audit_Trail_Database
  TYPE: append-only store
  PURPOSE: Immutable record of every regulated decision + producer action
  STORES: decision events, operator actions, score values at decision time, source provenance
  CRITICAL: this is the legal record carriers and regulators rely on
```

### 2.8 Contract Subsystem (Producer Appointment)

```
COMPONENT: Contract_Decision_Engine
  TYPE: service
  PURPOSE: Auto-decides producer appointment based on Producer_Quality + carrier appointment rules
  CONSUMES: Producer Quality, NIPR data, state licensing, carrier rules
  PROVIDES: appointment decision (approve / require-review / decline)

COMPONENT: Contract_dB
  TYPE: store
  PURPOSE: System of record for producer-carrier contracts
  STORES: contract terms, appointment status, commission schedule, effective dates, termination history

COMPONENT: Document_Submission
  TYPE: service
  PURPOSE: Handles e-signature and document workflows for contracting
  PROVIDES: signed and timestamped contract artifacts
```

### 2.9 Identity / Hierarchy Subsystem [formalized]

```
COMPONENT: Producer
  TYPE: entity
  STORES: license info, NIPR data, state appointments, Opal Score, contact info

COMPONENT: Agency
  TYPE: entity
  STORES: agency identity, owners, contracted carriers, hierarchy metadata
  RELATIONSHIPS: has many Producers

COMPONENT: Carrier_View                                         [new — formalizes left-side of whiteboard]
  TYPE: derived view (materialized or live)
  PURPOSE: Per-carrier aggregated view of all their appointed producers across agencies
  CONSUMES: Producer + Agency + Contract_dB
  PROVIDES: carrier-facing dashboard data (NOT to be confused with HIL underwriting UI)
```

---

## 3. API Boundary

The horizontal API line on the whiteboard mediates four named channels:

```
CHANNEL: new_submission
  DIRECTION: producer → carrier
  PAYLOAD: complete application + Opal Score + audit trail reference
  TRIGGER: eApp submit

CHANNEL: policy_state
  DIRECTION: carrier → producer
  PAYLOAD: policy lifecycle events (issued, in-force, lapsed, terminated, contested)
  TRIGGER: carrier-side state change

CHANNEL: uw_quote
  DIRECTION: bidirectional
  PAYLOAD: pre-submission underwriting check (rate class estimate)
  TRIGGER: producer requests pre-validation

CHANNEL: score_query                                            [new — was implicit]
  DIRECTION: carrier → producer side (read)
  PAYLOAD: Opal Score request for a producer
  TRIGGER: carrier underwriting routing decision
```

---

## 4. Named Flows (end-to-end pathways)

### 4.1 Producer dials a prospect

```
TRIGGER: producer action in Dial Block mission
PATH:
  CRM (mission)
    → Compliance_Subsystem [DNC_Service, Quiet_Hours_Service, Suppression_Engine — all gates]
    → Twilio_Bridge (if all gates pass)
    → Recording_Disclosure (at call start, state-aware)
    → Recording_Store (audio) + Transcription_Stream (live ASR)
```

### 4.2 Live transcript becomes substrate facts

```
TRIGGER: transcript chunk received
PATH:
  Transcription_Stream
    → CRM (display, read-only)
    → Enrichment_Service [Field_Extractor extracts; Objection_Classifier tags]
    → Contact (candidate field updates with provenance + confidence)
    → Supabase (persisted)
```

### 4.3 Application submission to carrier

```
TRIGGER: producer taps "submit" in eApp mission
PATH:
  eApp
    → Compliance_Subsystem [Consent_Ledger verification, suitability check]
    → API new_submission channel
    → Carrier Router (consumes Opal Score for routing decision)
    → Instant_Decision_Engine OR HIL_Underwriting
    → Audit_Trail_Database (decision written)
    → Policy_Book (on issue)
    → API policy_state channel (back to producer)
    → Supabase (status update)
    → CRM (status visible to producer)
```

### 4.4 Score recomputation

```
TRIGGER: any substrate write event tagged audit-relevant
PATH:
  Supabase event stream
    → Opal_Score_Calculator
    → Score_Audit_Log (computation traced)
    → Supabase (updated score persisted)
    → consumed by Carrier_Side Router, Contract_Decision_Engine, Product_Lookup Carrier_Ranking
```

### 4.5 Carrier Quality feedback to producer side

```
TRIGGER: carrier-side decision or policy state change
PATH:
  Audit_Trail_Database event
    → Carrier_Quality_Computer
    → Producer Side View_Generator (carrier rankings update)
    → CRM (producer sees updated carrier quality during product selection)
```

### 4.6 Producer onboarding (contracting)

```
TRIGGER: producer initiates contracting with a carrier
PATH:
  CRM (contracting mission)
    → Document_Submission
    → Contract_Decision_Engine (consumes Producer Quality)
    → Contract_dB (contract written)
    → Carrier_View update (carrier sees new producer)
```

### 4.7 Compliance gate (cross-cutting pattern)

```
APPLIES TO: every outbound dial, every SMS send, every application submission, every recording
PATTERN:
  initiating subsystem
    → Compliance_Subsystem (relevant gates)
    → permission boolean
    → proceed (if permitted) or block (if not, with reason logged)
```

---

## 5. Score Flow Map

```
Opal_Score                      [computed at producer side]
  consumed by: Carrier_Router, Contract_Decision_Engine, Carrier_Ranking, CRM (self-view)
  
Producer_Quality                [aggregated from Opal_Score + lapse/chargeback history]
  consumed by: Carrier_Ranking, Contract_Decision_Engine
  
Carrier_Quality                 [computed at carrier side]
  consumed by: Product_Lookup Carrier_Ranking, Producer Side View_Generator (carrier display)
  
UW_Score                        [per-application carrier-side]
  consumed by: Opal_Score_Calculator (feedback loop)
```

---

## 6. Notes on architectural commitments made explicit

1. **HIL_Underwriting is carrier-facing UX, not just an API.** Building this means Opal is delivering workflow tooling to carrier employees, not just integration. This is a deliberate scope choice — it's what makes "deep integration" deep, but it doubles the user base Opal is designing for.

2. **Score_Audit_Log is structurally required.** Without it, the Opal Score is unexplainable when challenged. Any regulated scoring system needs explainability infrastructure. This belongs in the foundation, not as a feature.

3. **Compliance_Subsystem is a gate-pattern collection, not a single service.** Each gate (DNC, Quiet Hours, Suppression, Consent verification, Recording Disclosure) is synchronous and blocks the calling subsystem if it returns no-permission. This is intentional — compliance is a hard gate, not a soft check.

4. **Carrier_View is a derived view.** The original whiteboard topology (producers → agencies → Carrier View → DB) is best modeled as a materialized view on top of Producer + Agency + Contract_dB rather than its own data store. It can be physically materialized for performance but logically it's derived.

5. **A2P_10DLC_Manager is represented but deferred.** SMS is out of v1 per the 90-day scope. Listing the component now so the architecture has a place for it when SMS ships in Phase 2 prevents retrofitting.

6. **The View_Generator is where mission state lives.** This is the connective tissue between the mission paradigm and the substrate. It deserves architectural attention because every mission's UX hangs off how it queries.

---

## 7. What's not yet modeled (potential v2)

- Carrier-facing analytics / reporting beyond HIL underwriting workflows
- Reinsurer-facing exports
- Regulator-facing audit access patterns
- Multi-region deployment topology
- Disaster recovery / data retention specifics
- Inter-agency hierarchy beyond producer/agency/business (IMOs, FMOs at platform level)
- E&O carrier integration (referenced but not yet a subsystem)
- Lead Exchange (revenue line from chart, not yet modeled)

These are deferred until either alpha learns something that constrains them, or carrier-side conversations begin.
