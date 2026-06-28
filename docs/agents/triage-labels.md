# Triage Label Configuration

This repo uses the default triage label vocabulary.

## Label Mapping

The `triage` skill applies these labels to issues (or the equivalent in your issue tracker):

| Canonical Role | Label String |
|---------------|--------------|
| needs-triage | needs-triage |
| needs-info | needs-info |
| ready-for-agent | ready-for-agent |
| ready-for-human | ready-for-human |
| wontfix | wontfix |

## State Machine

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` — needs human implementation
- `wontfix` — will not be actioned
