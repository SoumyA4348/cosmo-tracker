from __future__ import annotations

import csv
import hmac
import io
import mimetypes
import os
import random
import sqlite3
from contextlib import asynccontextmanager, contextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("COSMO_DATABASE_PATH", BASE_DIR / "cosmo.db"))
STATIC_DIR = BASE_DIR / "static"
USER_ID = 1

HABITS = {
    "reading_completed": "Reading",
    "prof_dev_completed": "Professional Development",
    "healthy_eating_completed": "Healthy Eating",
    "family_time_completed": "Family / Quality Social Time",
    "bed_on_time_completed": "Bed on Time",
}
STREAK_HABITS = (
    "reading_completed",
    "prof_dev_completed",
    "healthy_eating_completed",
    "bed_on_time_completed",
)

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS daily_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    date TEXT NOT NULL,
    day_of_week TEXT NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0,
    exercise_minutes INTEGER NOT NULL DEFAULT 0,
    sleep_hours REAL NOT NULL DEFAULT 0.0,
    resting_hr INTEGER,
    water_liters REAL NOT NULL DEFAULT 0.0,
    reading_completed INTEGER NOT NULL DEFAULT 0,
    prof_dev_completed INTEGER NOT NULL DEFAULT 0,
    healthy_eating_completed INTEGER NOT NULL DEFAULT 0,
    family_time_completed INTEGER NOT NULL DEFAULT 0,
    bed_on_time_completed INTEGER NOT NULL DEFAULT 0,
    day_rating INTEGER,
    notes TEXT,
    score_health REAL NOT NULL DEFAULT 0.0,
    score_dev REAL NOT NULL DEFAULT 0.0,
    score_lifestyle REAL NOT NULL DEFAULT 0.0,
    score_total REAL NOT NULL DEFAULT 0.0,
    score_tier TEXT NOT NULL DEFAULT 'CRITICAL',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
)
"""

# These definitions are also applied to existing databases on startup. SQLite
# cannot add CURRENT_TIMESTAMP as a non-constant ALTER TABLE default, so the
# timestamp migration uses a plain text column and backfills it below.
MIGRATION_COLUMNS = {
    "user_id": "INTEGER NOT NULL DEFAULT 1",
    "date": "TEXT NOT NULL DEFAULT ''",
    "day_of_week": "TEXT NOT NULL DEFAULT ''",
    "steps": "INTEGER NOT NULL DEFAULT 0",
    "exercise_minutes": "INTEGER NOT NULL DEFAULT 0",
    "sleep_hours": "REAL NOT NULL DEFAULT 0.0",
    "resting_hr": "INTEGER",
    "water_liters": "REAL NOT NULL DEFAULT 0.0",
    "reading_completed": "INTEGER NOT NULL DEFAULT 0",
    "prof_dev_completed": "INTEGER NOT NULL DEFAULT 0",
    "healthy_eating_completed": "INTEGER NOT NULL DEFAULT 0",
    "family_time_completed": "INTEGER NOT NULL DEFAULT 0",
    "bed_on_time_completed": "INTEGER NOT NULL DEFAULT 0",
    "day_rating": "INTEGER",
    "notes": "TEXT",
    "score_health": "REAL NOT NULL DEFAULT 0.0",
    "score_dev": "REAL NOT NULL DEFAULT 0.0",
    "score_lifestyle": "REAL NOT NULL DEFAULT 0.0",
    "score_total": "REAL NOT NULL DEFAULT 0.0",
    "score_tier": "TEXT NOT NULL DEFAULT 'CRITICAL'",
    "created_at": "TEXT",
    "updated_at": "TEXT",
}


class CheckinRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    log_date: date = Field(default_factory=date.today, alias="date")
    steps: int = Field(default=0, ge=0, le=500_000)
    exercise_minutes: int = Field(default=0, ge=0, le=1_440)
    sleep_hours: float = Field(default=0.0, ge=0, le=24)
    resting_hr: int | None = Field(default=None, ge=20, le=250)
    water_liters: float = Field(default=0.0, ge=0, le=100)
    reading_completed: int = Field(default=0, ge=0, le=1)
    prof_dev_completed: int = Field(default=0, ge=0, le=1)
    healthy_eating_completed: int = Field(default=0, ge=0, le=1)
    family_time_completed: int = Field(default=0, ge=0, le=1)
    bed_on_time_completed: int = Field(default=0, ge=0, le=1)
    day_rating: int | None = Field(default=None, ge=1, le=4)
    notes: str | None = Field(default=None, max_length=2_000)


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def calculate_steps_score(steps: int) -> float:
    if steps >= 10_000:
        return 10.0
    if steps >= 8_000:
        return steps / 1_000
    if steps >= 6_000:
        # The brief's tier example explicitly assigns 5 points at 6,500.
        return 5.0
    return 0.0


def calculate_sleep_score(hours: float) -> float:
    if 7.0 <= hours <= 8.5:
        return 10.0
    if 6.0 <= hours < 7.0 or 8.5 < hours <= 9.0:
        return 7.5
    if 5.0 <= hours < 6.0 or 9.0 < hours <= 9.5:
        return 5.0
    return 2.0


def score_tier(total: float) -> str:
    if total >= 90:
        return "OPTIMAL"
    if total >= 80:
        return "SOLID"
    if total >= 70:
        return "BASELINE"
    if total >= 60:
        return "SUBOPTIMAL"
    return "CRITICAL"


def calculate_scores(values: dict[str, Any]) -> dict[str, Any]:
    steps = int(values.get("steps") or 0)
    exercise = int(values.get("exercise_minutes") or 0)
    sleep = float(values.get("sleep_hours") or 0)
    water = float(values.get("water_liters") or 0)

    health = (
        calculate_steps_score(steps)
        + min(exercise, 30) / 30 * 15
        + calculate_sleep_score(sleep)
        + min(water, 2.5) / 2.5 * 5
    )
    dev = (
        int(values.get("prof_dev_completed") or 0) * 15
        + int(values.get("reading_completed") or 0) * 10
    )
    lifestyle = (
        int(values.get("healthy_eating_completed") or 0) * 15
        + int(values.get("family_time_completed") or 0) * 10
        + int(values.get("bed_on_time_completed") or 0) * 10
    )
    health = round(health, 2)
    dev = round(dev, 2)
    lifestyle = round(lifestyle, 2)
    total = round(health + dev + lifestyle, 2)
    return {
        "score_health": health,
        "score_dev": dev,
        "score_lifestyle": lifestyle,
        "score_total": total,
        "score_tier": score_tier(total),
    }


def ensure_schema() -> None:
    with database() as connection:
        connection.execute(CREATE_TABLE_SQL)
        existing = {
            row["name"] for row in connection.execute("PRAGMA table_info(daily_logs)")
        }
        for name, definition in MIGRATION_COLUMNS.items():
            if name not in existing:
                connection.execute(
                    f'ALTER TABLE daily_logs ADD COLUMN "{name}" {definition}'
                )
        connection.execute(
            "UPDATE daily_logs SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"
        )
        connection.execute(
            "UPDATE daily_logs SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL"
        )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_daily_logs_user_date "
            "ON daily_logs(user_id, date)"
        )


def upsert_record(values: dict[str, Any]) -> dict[str, Any]:
    log_date = date.fromisoformat(str(values["date"]))
    normalized = {
        "user_id": USER_ID,
        "date": log_date.isoformat(),
        "day_of_week": log_date.strftime("%A"),
        "steps": int(values.get("steps") or 0),
        "exercise_minutes": int(values.get("exercise_minutes") or 0),
        "sleep_hours": float(values.get("sleep_hours") or 0),
        "resting_hr": values.get("resting_hr"),
        "water_liters": float(values.get("water_liters") or 0),
        **{key: int(values.get(key) or 0) for key in HABITS},
        "day_rating": values.get("day_rating"),
        "notes": values.get("notes"),
    }
    normalized.update(calculate_scores(normalized))
    columns = list(normalized)
    placeholders = ", ".join("?" for _ in columns)
    update_columns = [name for name in columns if name not in ("user_id", "date")]
    updates = ", ".join(f"{name} = excluded.{name}" for name in update_columns)
    with database() as connection:
        connection.execute(
            f"""
            INSERT INTO daily_logs ({", ".join(columns)})
            VALUES ({placeholders})
            ON CONFLICT(user_id, date) DO UPDATE SET
                {updates},
                updated_at = CURRENT_TIMESTAMP
            """,
            [normalized[name] for name in columns],
        )
        row = connection.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? AND date = ?",
            (USER_ID, normalized["date"]),
        ).fetchone()
    return dict(row)


def seed_sample_data(days: int = 21) -> int:
    with database() as connection:
        count = connection.execute("SELECT COUNT(*) FROM daily_logs").fetchone()[0]
    if count:
        return 0

    today = date.today()
    habits_chance = {
        "reading_completed": 0.68,
        "prof_dev_completed": 0.61,
        "healthy_eating_completed": 0.75,
        "family_time_completed": 0.64,
        "bed_on_time_completed": 0.70,
    }
    for offset in range(days - 1, -1, -1):
        log_date = today - timedelta(days=offset)
        rng = random.Random(log_date.isoformat())
        values = {
            "date": log_date.isoformat(),
            "steps": rng.randint(4_800, 13_800),
            "exercise_minutes": rng.randint(8, 48),
            "sleep_hours": round(rng.uniform(5.2, 9.2), 1),
            "resting_hr": rng.randint(54, 75),
            "water_liters": round(rng.uniform(1.1, 3.5), 1),
            "day_rating": rng.randint(2, 4),
            "notes": None,
        }
        values.update(
            {habit: int(rng.random() < chance) for habit, chance in habits_chance.items()}
        )
        upsert_record(values)
    return days


def get_record(log_date: str) -> dict[str, Any] | None:
    with database() as connection:
        row = connection.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? AND date = ?",
            (USER_ID, log_date),
        ).fetchone()
    return dict(row) if row else None


def completion_streaks() -> list[dict[str, Any]]:
    with database() as connection:
        rows = connection.execute(
            "SELECT date, " + ", ".join(STREAK_HABITS)
            + " FROM daily_logs WHERE user_id = ? ORDER BY date",
            (USER_ID,),
        ).fetchall()

    by_date = {
        date.fromisoformat(row["date"]): dict(row)
        for row in rows
        if row["date"]
    }
    today = date.today()
    result = []
    for key in STREAK_HABITS:
        completed_dates = sorted(
            day for day, row in by_date.items() if int(row[key] or 0) == 1
        )
        record = current_run = previous = 0
        for completed in completed_dates:
            current_run = current_run + 1 if previous and completed == previous + timedelta(days=1) else 1
            record = max(record, current_run)
            previous = completed

        if by_date.get(today) is not None:
            cursor = today
            current = 0
            while cursor in by_date and int(by_date[cursor][key] or 0) == 1:
                current += 1
                cursor -= timedelta(days=1)
        else:
            cursor = today - timedelta(days=1)
            current = 0
            while cursor in by_date and int(by_date[cursor][key] or 0) == 1:
                current += 1
                cursor -= timedelta(days=1)

        result.append(
            {
                "key": key,
                "name": HABITS[key],
                "current": current,
                "record": record,
            }
        )
    return result


def bottleneck_report() -> dict[str, Any]:
    start = date.today() - timedelta(days=29)
    with database() as connection:
        rows = connection.execute(
            "SELECT date, " + ", ".join(HABITS)
            + " FROM daily_logs WHERE user_id = ? AND date >= ? AND date <= ? "
            "ORDER BY date",
            (USER_ID, start.isoformat(), date.today().isoformat()),
        ).fetchall()

    habit_stats = []
    for key, name in HABITS.items():
        completed = sum(int(row[key] or 0) for row in rows)
        adherence = round(completed / len(rows) * 100, 1) if rows else 0.0
        habit_stats.append(
            {
                "key": key,
                "name": name,
                "completed": completed,
                "days_logged": len(rows),
                "adherence": adherence,
            }
        )
    lowest = min(habit_stats, key=lambda item: item["adherence"]) if rows else None
    return {
        "window_days": 30,
        "days_analyzed": len(rows),
        "bottleneck": lowest,
        "habits": habit_stats,
    }


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    ensure_schema()
    seed_sample_data()
    yield


app = FastAPI(title="Cosmo-Tracker", version="1.0.0", lifespan=lifespan)


def check_api_key(
    request: Request,
    x_cosmo_key: str | None,
    query_key: str | None,
) -> None:
    expected = os.environ.get("COSMO_API_KEY")
    if not expected:
        return
    supplied = x_cosmo_key or query_key or ""
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing Cosmo API key")


@app.get("/")
def dashboard() -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=503, detail="Dashboard assets are not ready")
    return FileResponse(index)


@app.get("/static/{asset_path:path}")
def static_asset(asset_path: str) -> FileResponse:
    target = (STATIC_DIR / asset_path).resolve()
    if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    media_type = (
        "image/svg+xml"
        if target.suffix.lower() == ".svg"
        else mimetypes.guess_type(target.name)[0]
    )
    return FileResponse(target, media_type=media_type)


@app.post("/api/checkin", status_code=201)
def create_checkin(
    payload: CheckinRequest,
    request: Request,
    x_cosmo_key: str | None = Header(default=None),
    key: str | None = Query(default=None),
) -> dict[str, Any]:
    check_api_key(request, x_cosmo_key, key)
    return upsert_record(payload.model_dump(by_alias=True))


@app.get("/api/day/{log_date}")
def day_record(log_date: date) -> dict[str, Any]:
    record = get_record(log_date.isoformat())
    if record is None:
        raise HTTPException(status_code=404, detail="No record for date")
    return record


@app.get("/api/history")
def history(days: int = Query(default=7, ge=1, le=3_650)) -> list[dict[str, Any]]:
    end = date.today()
    start = end - timedelta(days=days - 1)
    with database() as connection:
        rows = connection.execute(
            """
            SELECT date, day_of_week, score_total, score_health, score_dev,
                   score_lifestyle, score_tier
            FROM daily_logs
            WHERE user_id = ? AND date >= ? AND date <= ?
            ORDER BY date ASC
            """,
            (USER_ID, start.isoformat(), end.isoformat()),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/streaks")
def streaks() -> dict[str, Any]:
    habits = completion_streaks()
    result: dict[str, Any] = {"habits": habits}
    for item in habits:
        result[item["key"].removesuffix("_completed")] = {
            "current": item["current"],
            "record": item["record"],
        }
    return result


@app.get("/api/bottleneck")
def bottleneck() -> dict[str, Any]:
    return bottleneck_report()


@app.get("/api/export/csv")
def export_csv() -> StreamingResponse:
    with database() as connection:
        rows = connection.execute(
            "SELECT * FROM daily_logs WHERE user_id = ? ORDER BY date ASC", (USER_ID,)
        ).fetchall()
        columns = [
            column["name"]
            for column in connection.execute("PRAGMA table_info(daily_logs)")
        ]
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(columns)
    writer.writerows([tuple(row) for row in rows])
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="cosmo-tracker-export.csv"'},
    )


@app.post("/api/seed")
def seed() -> dict[str, Any]:
    inserted = seed_sample_data()
    return {"inserted": inserted, "message": "Sample telemetry seeded" if inserted else "Database already contains data"}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "online"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
