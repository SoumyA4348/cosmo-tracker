# Cosmo-Tracker

Personal daily telemetry dashboard backed by FastAPI and SQLite.

## Run

For a direct local run:

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8080
```

For a local computer, run `install-and-run-windows.bat` on Windows. On macOS
or Linux, run `chmod +x install-and-run-macos-linux.sh` once, then
`./install-and-run-macos-linux.sh`. These scripts create a private `.venv`,
install the dependencies, and start the dashboard.

The Replit preview runs on port 5000. On first startup, the app creates or
migrates `cosmo.db` and seeds 21 days of sample data only when the database is
empty.

## Apple Shortcut

Send a `POST` request to `/api/checkin` with a JSON body containing `date`
(`YYYY-MM-DD`) and any telemetry or habit fields. Omitted metrics default to
zero. If `COSMO_API_KEY` is configured in the app's environment, include it as
the `X-Cosmo-Key` header; query parameter `key` is also supported for
compatibility with Shortcuts.

## API

- `POST /api/checkin` — calculate scores and create/update a daily log
- `GET /api/day/{date}` — retrieve a daily log
- `GET /api/history?days=7` — retrieve recent scores
- `GET /api/streaks` — current and best habit streaks
- `GET /api/bottleneck` — 30-day habit adherence summary
- `GET /api/export/csv` — download all daily logs
- `POST /api/seed` — seed sample data only if there are no logs

Run the test suite with `pytest`.