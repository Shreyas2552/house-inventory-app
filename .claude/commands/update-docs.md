Update README.md and CHANGELOG.md to reflect the latest changes in this repository.

Follow these steps exactly:

## Step 1 — Understand what changed

Run these commands to gather context:
- `git log --oneline -10` — see recent commits
- `git diff HEAD~1 HEAD --stat` — see which files changed in the last commit
- `git diff HEAD~1 HEAD -- server/src/scrapers/ server/src/index.ts house-inventory-app/App.tsx house-inventory-app/src/priceSearch.ts house-inventory-app/src/types.ts` — see what the code changes actually were

Read the current state of:
- `CHANGELOG.md` — to find the last documented version and date
- `README.md` — to understand what is currently documented

## Step 2 — Update CHANGELOG.md

Determine the new version number by incrementing the MINOR version (v2.0 → v2.1, v2.1 → v2.2, etc.). Use MAJOR bumps only for complete rewrites.

Add a new entry at the TOP of the changelog (below the title line) in this format:

```
## v{X.Y} — {YYYY-MM-DD} · {short title for this release}

### Added
- bullet points for new features, scrapers, UI elements

### Changed
- bullet points for modifications to existing behaviour

### Fixed
- bullet points for bug fixes

### Removed (if applicable)
- bullet points for anything deleted
```

Only include sections that have content. Skip empty sections.

## Step 3 — Update README.md (only if the code change affects user-facing behaviour)

Update README.md when any of the following change:
- A new store or data source is added → update "How Price Search Works" and "Store Coverage Summary" table
- A new feature is added to the app → update the "Features" bullet list
- Setup steps change → update the "Setup" section
- A new API key is required → update the API Keys table

Do NOT update README for: internal refactors, bug fixes that don't change behaviour, test files, or server-only performance improvements.

## Step 4 — Stage the updated files

After editing, run:
```
git add README.md CHANGELOG.md
```

Then report: what version was added to CHANGELOG, and whether README was updated or left unchanged (and why).
