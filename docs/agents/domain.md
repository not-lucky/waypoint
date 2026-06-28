# Domain Documentation Configuration

This repo uses a single-context layout.

## Layout

- `CONTEXT.md` at the repo root contains the project's domain language and ubiquitous language
- `docs/adr/` at the repo root contains architectural decision records

## Consumer Rules

Skills that read domain documentation (`improve-codebase-architecture`, `diagnosing-bugs`, `tdd`) should:

1. Read `CONTEXT.md` to understand the project's domain terminology
2. Check `docs/adr/` for past architectural decisions relevant to the current work
3. Use the domain language from `CONTEXT.md` when discussing or describing changes
