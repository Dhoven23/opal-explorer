# Opal Architecture — Mermaid Visualizations v1

Generated from `opal_architecture_model.md`. Each diagram is scoped to one audience or conversation. Edit by editing the Mermaid source — these render in GitHub, Notion, most markdown viewers, and Claude artifacts.

---

## 1. System Context — who interacts with Opal

For non-technical audiences (investors, carriers in first conversations, advisors). Shows Opal as a black box with the actors and external systems around it.

```mermaid
flowchart LR
    Producer([Producer<br/>licensed agent])
    Agency([Agency Owner<br/>manages downlines])
    Underwriter([Carrier Underwriter<br/>reviews HIL cases])
    LeadSource[(Lead Sources<br/>vendors, marketing)]
    Carrier[(Carriers<br/>life insurance companies)]
    Regulator([Regulators<br/>state DOIs, future])

    Opal{{Opal}}

    Producer -->|runs missions, makes sales| Opal
    Agency -->|views performance, manages team| Opal
    Underwriter -->|reviews applications, decisions| Opal
    LeadSource -->|provides leads| Opal
    Opal -->|submits applications, queries UW| Carrier
    Carrier -->|returns decisions, policy state| Opal
    Opal -.->|audit access<br/>future| Regulator

    style Opal fill:#ff8c42,stroke:#333,stroke-width:3px,color:#fff
```

---

## 2. Subsystem Overview — the 9 subsystems and primary flows

For engineering and architecture conversations. Each subsystem is a single node; cross-cutting flows shown with labels.

```mermaid
flowchart TB
    subgraph PROD["Producer Side"]
        direction TB
        CRM[CRM<br/>mission UI]
        SUB[(Supabase<br/>substrate)]
        EAPP[eApp]
    end

    TEL[Telephony Subsystem<br/>Twilio + Deepgram + Recording]
    AI[AI Enrichment Subsystem<br/>extraction + summarization]
    COMP[Compliance Subsystem<br/>DNC, Quiet Hours, Consent, Suppression]
    SCORE[Scoring Engine Subsystem<br/>Opal Score + Quality computers]
    LOOKUP[Product Lookup Subsystem<br/>ranking, comp, contracts viewer]

    subgraph CARR["Carrier Side"]
        direction TB
        ROUTER[Router]
        UW[Instant + HIL Underwriting]
        AUDIT[(Audit Trail DB)]
        POLICY[(Policy Book)]
    end

    CONTRACT[Contract Subsystem<br/>appointment + documents]
    IDENT[Identity / Hierarchy<br/>Producer, Agency, Carrier_View]

    PROD -->|gated by| COMP
    PROD -->|telephony via| TEL
    TEL -->|transcripts to| AI
    AI -->|facts to| PROD
    PROD -->|application via API| CARR
    CARR -->|policy state via API| PROD
    PROD -->|substrate events| SCORE
    CARR -->|UW events| SCORE
    SCORE -->|Opal Score| CARR
    SCORE -->|Producer Quality| CONTRACT
    SCORE -->|Carrier Quality| LOOKUP
    LOOKUP -->|product surfacing| PROD
    CONTRACT -->|registered in| IDENT
    IDENT -->|access control| PROD

    style PROD fill:#fff5e6,stroke:#ff8c42
    style CARR fill:#e6f3ff,stroke:#4a90e2
    style SCORE fill:#ffe6e6,stroke:#d9534f
    style COMP fill:#e6ffe6,stroke:#5cb85c
```

---

## 3. Producer Side — internal components

For engineering team and UX conversations. Shows what lives inside the Producer Side subsystem.

```mermaid
flowchart TB
    subgraph PROD["Producer Side"]
        CRM[CRM<br/>mission canvas]
        VIEWGEN[View Generator<br/>renders mission views]
        CONTACT[Contact<br/>entity]
        ENRICH[Enrichment Service<br/>AI pipeline]
        SUPA[(Supabase<br/>substrate)]
        HIER[Hierarchy Constructor]
        AMS[AMS<br/>agency mgmt]
        EAPP[eApp<br/>application generator]
    end

    USER([Producer])
    TEL_IN[/transcripts<br/>from Telephony/]
    AI_OUT[\extracted facts<br/>from Enrichment/]
    API_OUT[/submissions<br/>to API/]
    API_IN[\policy state<br/>from API\]

    USER -->|mission context| VIEWGEN
    VIEWGEN -->|queries| SUPA
    VIEWGEN -->|renders| CRM
    CRM -->|displays| USER

    TEL_IN -->|streams| ENRICH
    ENRICH -->|updates with provenance| CONTACT
    CONTACT -->|persisted| SUPA

    SUPA --> HIER
    HIER -->|hierarchy graph| AMS
    EAPP -->|notification| AMS

    SUPA -->|PII| EAPP
    EAPP --> API_OUT
    API_IN --> SUPA

    style CRM fill:#fff5e6
    style SUPA fill:#fff,stroke:#333,stroke-width:2px
    style ENRICH fill:#ffe6cc
```

---

## 4. Carrier Side — internal components

For carrier compliance and integration conversations. Shows what runs on the carrier-facing pipeline.

```mermaid
flowchart TB
    API_IN[/new submission<br/>from API/]
    SCORE_IN[/Opal Score<br/>from Scoring Engine/]
    API_OUT[\policy state<br/>to API\]

    subgraph CARR["Carrier Side"]
        ROUTER[Router<br/>auto vs human]
        IDE[Instant Decision Engine]
        HIL[HIL Underwriting<br/>carrier human workflow]
        AUDIT[(Audit Trail DB<br/>append-only)]
        POLICY[(Policy Book)]
    end

    UNDERWRITER([Carrier Underwriter])

    API_IN --> ROUTER
    SCORE_IN --> ROUTER
    ROUTER -->|straight-through| IDE
    ROUTER -->|needs human| HIL
    HIL <-->|workflow| UNDERWRITER
    IDE --> AUDIT
    HIL --> AUDIT
    AUDIT -->|on issue| POLICY
    POLICY --> API_OUT
    AUDIT -.->|UW events| SCORE_OUT[\UW score<br/>to Scoring Engine\]

    style AUDIT fill:#ffe6e6,stroke:#d9534f,stroke-width:2px
    style HIL fill:#e6f3ff
```

---

## 5. Compliance gate pattern — cross-cutting enforcement

For compliance, legal, and carrier security conversations. Shows that every regulated action passes through a gate.

```mermaid
flowchart LR
    subgraph INITIATORS["Initiating Actions"]
        DIAL[Outbound Dial]
        SMS[SMS Send<br/>Phase 2]
        SUBMIT[Application Submit]
        RECORD[Call Recording]
    end

    subgraph COMP["Compliance Subsystem"]
        DNC[DNC Service]
        QH[Quiet Hours Service]
        DISC[Recording Disclosure]
        CON[Consent Ledger]
        SUPP[Suppression Engine]
        A2P[A2P 10DLC Manager<br/>deferred]
    end

    DIAL --> DNC
    DIAL --> QH
    DIAL --> SUPP
    SMS --> SUPP
    SMS --> A2P
    SUBMIT --> CON
    RECORD --> DISC
    DISC --> CON

    DNC -->|permission| RESULT{{permit / block}}
    QH -->|permission| RESULT
    SUPP -->|permission| RESULT
    CON -->|verified| RESULT
    DISC -->|played| RESULT
    A2P -->|registered| RESULT

    RESULT -->|if permitted| PROCEED[proceed with action]
    RESULT -->|if blocked| LOG[log denial reason]

    style COMP fill:#e6ffe6,stroke:#5cb85c,stroke-width:2px
    style RESULT fill:#fff,stroke:#333,stroke-width:2px
```

---

## 6. Scoring Engine — how scores propagate

For investor conversations about the moat, and carrier conversations about producer quality.

```mermaid
flowchart TB
    subgraph SOURCES["Event Sources"]
        SUBA[(Producer Substrate<br/>Supabase)]
        AUDA[(Carrier Audit Trail)]
    end

    subgraph SCORE["Scoring Engine Subsystem"]
        CALC[Opal Score Calculator<br/>event-driven]
        PQ[Producer Quality<br/>rolling metric]
        CQ[Carrier Quality<br/>rolling metric]
        UWS[UW Score Tracker]
        LOG[(Score Audit Log<br/>explainability)]
    end

    subgraph CONSUMERS["Score Consumers"]
        ROUT[Carrier Router]
        CDE[Contract Decision Engine]
        CRANK[Carrier Ranking]
        SELFVIEW[Producer Self-View<br/>in CRM]
        REINS[Reinsurer Reports<br/>future]
    end

    SUBA -->|writes trigger| CALC
    AUDA -->|UW outcomes| UWS
    UWS --> CALC
    CALC -->|every score event| LOG
    CALC --> PQ
    AUDA --> CQ

    CALC -->|Opal Score| ROUT
    PQ -->|Producer Quality| CDE
    PQ -->|Producer Quality| CRANK
    CQ -->|Carrier Quality| CRANK
    CALC -->|Opal Score| SELFVIEW
    LOG -.->|aggregate| REINS

    style CALC fill:#ffe6e6,stroke:#d9534f,stroke-width:2px
    style LOG fill:#fff,stroke:#333,stroke-width:2px
```

---

## 7. Application submission — end-to-end sequence

For engineering and carrier integration conversations. Shows the full path from operator submit to in-force policy.

```mermaid
sequenceDiagram
    actor P as Producer
    participant CRM
    participant Compliance
    participant eApp
    participant API
    participant Router
    participant UW as Underwriting<br/>(Instant / HIL)
    participant Audit as Audit Trail
    participant Policy as Policy Book
    participant Score as Scoring Engine

    P->>CRM: Tap submit in eApp mission
    CRM->>Compliance: verify consent + suitability + disclosures
    Compliance-->>CRM: permission granted (logged)
    CRM->>eApp: generate carrier-specific payload
    eApp->>API: new_submission (app + Opal Score + audit ref)
    API->>Router: route submission
    Router->>Score: query Opal Score
    Score-->>Router: score + provenance
    Router->>UW: route (auto or human)
    UW->>Audit: write decision + provenance
    UW-->>API: decision (approve / decline / refer)
    API-->>eApp: response
    eApp-->>CRM: update status
    CRM-->>P: status visible

    Note over UW,Policy: on approve
    UW->>Policy: create in-force policy
    Policy->>API: policy_state event
    API->>CRM: status update
    Policy->>Score: feeds UW Score back
    Score->>Score: recompute Opal Score
```

---

## 8. Call → transcript → substrate — the magical capability

For demos and engineering. Shows how a producer's call becomes structured substrate facts.

```mermaid
sequenceDiagram
    actor P as Producer
    participant CRM
    participant Compliance
    participant Twilio
    participant Disclosure as Recording<br/>Disclosure
    participant Deepgram
    participant Recording as Recording<br/>Store
    participant Enrich as Enrichment<br/>Service
    participant Extract as Field<br/>Extractor
    participant Contact
    participant Supa as Supabase

    P->>CRM: Click "dial" on next lead in Dial Block
    CRM->>Compliance: DNC + Quiet Hours + Suppression check
    Compliance-->>CRM: permitted (logged)
    CRM->>Twilio: place outbound call
    Twilio->>Disclosure: state-aware disclosure at call start
    Disclosure->>Recording: log disclosure played event

    Twilio->>Deepgram: stream audio
    loop During call
        Deepgram-->>CRM: live transcript chunks
        CRM-->>P: display transcript
    end

    Twilio->>Recording: store full audio post-call

    Deepgram->>Enrich: final transcript
    Enrich->>Extract: pull structured facts
    Extract-->>Enrich: DOB, state, smoker, conditions,<br/>callback prefs (with provenance)
    Enrich->>Contact: update fields
    Contact->>Supa: persist with audit trail

    Supa-->>CRM: Variable tab refreshes
    Note over P,CRM: Producer sees their conversation<br/>become structured substrate
```

---

## Notes on visualization choices

- **Color coding**: orange = producer side, blue = carrier side, red = scoring (the moat), green = compliance (the gate). Consistent across diagrams.
- **Shape coding**: `([rounded])` = persons/actors, `[(cylinder)]` = data stores, `[rectangle]` = services, `{{hexagon}}` = the whole system, `{diamond}` = decision points.
- **Dotted arrows** mean future / deferred, not implemented yet.
- **Sequence diagrams** for flows that need temporal ordering (submission, call processing).
- **Flowcharts** for everything else.

## When to use which diagram

| Diagram | Audience |
|---|---|
| 1. System Context | Investors, first-call carriers, advisors |
| 2. Subsystem Overview | Engineering hires, architecture deep-dives |
| 3. Producer Side detail | UX designers, frontend engineering |
| 4. Carrier Side detail | Carrier compliance/integration teams |
| 5. Compliance gate | Carrier compliance, legal, E&O conversations |
| 6. Scoring Engine | Investor moat conversations, carrier producer-quality discussions |
| 7. Application sequence | Engineering, carrier integration architects |
| 8. Call-to-substrate sequence | Product demos, "what makes this different" conversations |

For investor decks specifically, take diagram 1 and 6 and redraw them in Figma with proper visual design. These Mermaid versions are correct but not persuasive — the model is the source of truth, the polished visuals are the presentation layer.
