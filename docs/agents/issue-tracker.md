# Issue Tracker Configuration

This repo uses GitLab Issues as its issue tracker.

## CLI Tool

Issues are managed using the `glab` CLI tool. Ensure it is installed and authenticated:
```bash
# Install glab
# https://gitlab.com/gitlab-org/cli

# Authenticate
glab auth login
```

## Creating Issues

Use `glab issue create` to create new issues. The `to-issues` skill will call this command.

## Triaging Merge Requests

External merge requests are treated as a triage surface. The `triage` skill will pull external MRs into the same queue as issues and apply the same label-based state machine.

Collaborators' in-flight MRs are left alone and not triaged.
