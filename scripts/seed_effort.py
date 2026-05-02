#!/usr/bin/env python3
"""Populate `effort` for every node in opal_feature_graph.json per the
estimation spec (rule + 11 overrides). Re-run any time the rule, the
overrides, or the cost rate change.

Usage:  python3 scripts/seed_effort.py
"""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
GRAPH = ROOT / 'opal_feature_graph.json'

USD_PER_DEV_WEEK = 10_000

# weight -> (low, expected, high, teamSize)
WEEKS_BY_WEIGHT = {
    1: (1,  2,  3,  1),
    2: (3,  4,  6,  1),
    3: (6,  8,  12, 1),
    4: (12, 16, 24, 2),
    5: (24, 32, 48, 2),
}

AI_RX = re.compile(r'\b(ai|ml|llm|predictive|transcript|stt|speech-to-text)\b', re.I)
COMPLIANCE_RX = re.compile(
    r'\b(compliance|compliant|regulator|regulatory|hipaa|cms|two-party)\b', re.I
)

OVERRIDES = {
    'eapp-extension': dict(
        devWeeksLow=12, devWeeksExpected=18, devWeeksHigh=28, teamSize=2,
        notes='Per-carrier work; covers ~10 high-volume carriers at ~1.5 wk each. '
              'Gives day-one carrier coverage with zero carrier cooperation.'
    ),
    'eapp-native': dict(
        devWeeksLow=4, devWeeksExpected=6, devWeeksHigh=10, teamSize=1,
        notes='PER-CARRIER integration. Multiply by integrated-carrier count for total. '
              'Gated on carrier API access — unblocked by relationship work, not eng.'
    ),
    'eapp-middleware': dict(
        devWeeksLow=6, devWeeksExpected=10, devWeeksHigh=16, teamSize=1,
        notes='Per-aggregator-carrier-list config. Aggregator amortizes some work across carriers.'
    ),
    'carrier-end-to-end': dict(
        devWeeksLow=8, devWeeksExpected=12, devWeeksHigh=20, teamSize=2,
        notes='PER-CARRIER cost. Submission + UW status + commission feed. '
              'Most expensive single integration line in the system.'
    ),
    'carrier-api-spec': dict(
        devWeeksLow=20, devWeeksExpected=40, devWeeksHigh=80, teamSize=1,
        externalCostsUsd=0,
        notes='Standards/coordination work, not pure engineering. '
              'Majority of effort is partner alignment and spec evangelism.'
    ),
    'lead-exchange': dict(
        devWeeksLow=24, devWeeksExpected=40, devWeeksHigh=70, teamSize=3,
        externalCostsUsd=100_000,
        notes='Two-sided marketplace + payments + escrow + dispute resolution. '
              'Marketplace dynamics dwarf eng cost.'
    ),
    'rx-prequal': dict(
        devWeeksLow=8, devWeeksExpected=14, devWeeksHigh=24, teamSize=2,
        externalCostsUsd=75_000,
        notes='$50–100K external for prescription dataset. '
              'Model accuracy improves with submission volume — long-term moat.'
    ),
    'multi-tenant': dict(
        devWeeksLow=10, devWeeksExpected=14, devWeeksHigh=22, teamSize=2,
        notes='Foundational refactor. ~3× the cost if retrofitted after the fact — '
              'do it once, do it early.'
    ),
    'industry-data': dict(
        devWeeksLow=16, devWeeksExpected=28, devWeeksHigh=50, teamSize=2,
        externalCostsUsd=50_000,
        notes='Compliance, contracts, and partner agreements drive cost more than engineering.'
    ),
    'commission-recon': dict(
        devWeeksLow=10, devWeeksExpected=18, devWeeksHigh=32, teamSize=1,
        notes='Carrier statement formats are wildly inconsistent. Effort grows '
              'roughly linearly with carrier count via the long tail of edge cases.'
    ),
    'illustration-gen': dict(
        devWeeksLow=10, devWeeksExpected=16, devWeeksHigh=28, teamSize=2,
        notes='Per-carrier compliance review cycles serial-bottleneck this work.'
    ),
}


def rule_effort(node):
    L, E, H, ts = WEEKS_BY_WEIGHT[node['weight']]
    cat_mult = 1.0
    if node['category'] == 'integration':
        cat_mult *= 1.30
    if node['category'] == 'core':
        cat_mult *= 1.20
    desc_mult = 1.0
    if AI_RX.search(node['description']):
        desc_mult *= 1.40
    if COMPLIANCE_RX.search(node['description']):
        desc_mult *= 1.15
    mult = cat_mult * desc_mult
    return {
        'devWeeksLow':      round(L * mult, 1),
        'devWeeksExpected': round(E * mult, 1),
        'devWeeksHigh':     round(H * mult * 1.10, 1),
        'teamSize':         ts,
    }


def main():
    data = json.loads(GRAPH.read_text())

    rule_count = 0
    override_count = 0
    external_count = 0
    naive_total_weeks = 0
    naive_total_cost = 0
    external_total = 0

    for node in data['nodes']:
        if node['layer'] == 'external':
            node['effort'] = {
                'devWeeksLow': 0,
                'devWeeksExpected': 0,
                'devWeeksHigh': 0,
                'teamSize': 0,
                'costUsdExpected': 0,
                'notes': 'External system — not built by Opal.',
            }
            external_count += 1
            continue

        eff = rule_effort(node)
        if node['id'] in OVERRIDES:
            eff.update(OVERRIDES[node['id']])
            override_count += 1
        else:
            rule_count += 1

        eff['costUsdExpected'] = round(
            eff['devWeeksExpected'] * eff['teamSize'] * USD_PER_DEV_WEEK
        )
        node['effort'] = eff

        naive_total_weeks += eff['devWeeksExpected']
        naive_total_cost += eff['costUsdExpected']
        external_total += eff.get('externalCostsUsd', 0) or 0

    data['costModel'] = {
        'usdPerDevWeek': USD_PER_DEV_WEEK,
        'description': 'Fully-loaded blended weekly rate per engineer '
                       '(salary + benefits + overhead). Default $10,000/wk.',
    }

    GRAPH.write_text(json.dumps(data, indent=2) + '\n')

    print(f'rule-based:  {rule_count} nodes')
    print(f'overrides:   {override_count} nodes')
    print(f'external:    {external_count} nodes')
    print(f'total nodes: {rule_count + override_count + external_count}')
    print(f'\nfull-graph (every non-external node, regardless of selection):')
    print(f'  naive sum:        {naive_total_weeks:.1f} dev-weeks')
    print(f'  naive cost:       ${naive_total_cost:,}')
    print(f'  external costs:   ${external_total:,}')


if __name__ == '__main__':
    main()
