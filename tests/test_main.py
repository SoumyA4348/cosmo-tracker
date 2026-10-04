import csv
import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "cosmo-test.db")
    monkeypatch.delenv("COSMO_API_KEY", raising=False)
    with TestClient(main.app) as test_client:
        yield test_client


def test_step_score_thresholds():
    assert main.calculate_steps_score(5_999) == 0
    assert main.calculate_steps_score(6_500) == 5
    assert main.calculate_steps_score(7_999) == 5
    assert main.calculate_steps_score(8_000) == 8
    assert main.calculate_steps_score(8_500) == 8.5
    assert main.calculate_steps_score(9_999) == 9.999
    assert main.calculate_steps_score(10_000) == 10


def test_sleep_score_bands():
    assert main.calculate_sleep_score(7.0) == 10
    assert main.calculate_sleep_score(8.5) == 10
    assert main.calculate_sleep_score(6.5) == 7.5
    assert main.calculate_sleep_score(9.0) == 7.5
    assert main.calculate_sleep_score(5.5) == 5
    assert main.calculate_sleep_score(9.3) == 5
    assert main.calculate_sleep_score(4.9) == 2
    assert main.calculate_sleep_score(9.6) == 2


def test_score_pillars_and_tier():
    scores = main.calculate_scores(
        {
            "steps": 10_000,
            "exercise_minutes": 30,
            "sleep_hours": 7.5,
            "water_liters": 2.5,
            "prof_dev_completed": 1,
            "reading_completed": 1,
            "healthy_eating_completed": 1,
            "family_time_completed": 1,
            "bed_on_time_completed": 1,
        }
    )
    assert scores == {
        "score_health": 40,
        "score_dev": 25,
        "score_lifestyle": 35,
        "score_total": 100,
        "score_tier": "OPTIMAL",
    }
    assert main.score_tier(89.99) == "SOLID"
    assert main.score_tier(79.99) == "BASELINE"
    assert main.score_tier(69.99) == "SUBOPTIMAL"
    assert main.score_tier(59.99) == "CRITICAL"


def test_startup_seeds_and_dashboard_loads(client):
    assert client.get("/").status_code == 200
    assert client.get("/api/health").json() == {"status": "online"}
    history = client.get("/api/history?days=7")
    assert history.status_code == 200
    assert 1 <= len(history.json()) <= 7


def test_checkin_defaults_optional_values_and_upserts(client):
    log_date = (date.today() + timedelta(days=1)).isoformat()
    response = client.post("/api/checkin", json={"date": log_date})
    assert response.status_code == 201
    record = response.json()
    assert record["steps"] == 0
    assert record["water_liters"] == 0
    assert record["reading_completed"] == 0
    assert record["score_total"] == 2
    assert record["score_tier"] == "CRITICAL"

    updated = client.post(
        "/api/checkin",
        json={"date": log_date, "steps": 8_500, "sleep_hours": 7.2},
    )
    assert updated.status_code == 201
    assert updated.json()["steps"] == 8_500
    assert updated.json()["score_health"] == 18.5
    assert client.get(f"/api/day/{log_date}").json()["score_total"] == 18.5


def test_checkin_validates_inputs(client):
    response = client.post(
        "/api/checkin",
        json={"date": date.today().isoformat(), "reading_completed": 2},
    )
    assert response.status_code == 422


def test_missing_day_returns_required_404(client):
    missing = date(1990, 1, 1).isoformat()
    response = client.get(f"/api/day/{missing}")
    assert response.status_code == 404
    assert response.json() == {"detail": "No record for date"}


def test_history_streaks_and_bottleneck_shapes(client):
    history = client.get("/api/history?days=7").json()
    assert all("score_total" in row and "score_tier" in row for row in history)
    streaks = client.get("/api/streaks").json()
    assert {item["key"] for item in streaks["habits"]} == {
        "reading_completed",
        "prof_dev_completed",
        "healthy_eating_completed",
        "bed_on_time_completed",
    }
    report = client.get("/api/bottleneck").json()
    assert report["window_days"] == 30
    assert report["days_analyzed"] > 0
    assert len(report["habits"]) == 5
    assert report["bottleneck"]["adherence"] == min(
        habit["adherence"] for habit in report["habits"]
    )


def test_csv_export_includes_headers_and_data(client):
    response = client.get("/api/export/csv")
    assert response.status_code == 200
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert rows
    assert {
        "date",
        "steps",
        "score_health",
        "score_dev",
        "score_lifestyle",
        "score_total",
        "score_tier",
        "created_at",
        "updated_at",
    }.issubset(rows[0])


def test_api_key_is_optional_until_configured(client, monkeypatch):
    monkeypatch.setenv("COSMO_API_KEY", "test-value")
    body = {"date": (date.today() + timedelta(days=2)).isoformat()}
    assert client.post("/api/checkin", json=body).status_code == 401
    assert client.post(
        "/api/checkin", json=body, headers={"X-Cosmo-Key": "test-value"}
    ).status_code == 201
    assert client.post(
        "/api/checkin", json=body, params={"key": "test-value"}
    ).status_code == 201


def test_schema_migration_adds_missing_columns(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "old.db")
    import sqlite3

    connection = sqlite3.connect(main.DATABASE_PATH)
    connection.execute(
        "CREATE TABLE daily_logs (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT)"
    )
    connection.execute(
        "INSERT INTO daily_logs (id, user_id, date) VALUES (1, 1, '2020-01-01')"
    )
    connection.commit()
    connection.close()

    main.ensure_schema()
    with main.database() as migrated:
        columns = {
            row["name"] for row in migrated.execute("PRAGMA table_info(daily_logs)")
        }
        row = migrated.execute(
            "SELECT day_of_week, score_total, created_at, updated_at "
            "FROM daily_logs WHERE id = 1"
        ).fetchone()
    assert "bed_on_time_completed" in columns
    assert row["score_total"] == 0
    assert row["created_at"]
    assert row["updated_at"]