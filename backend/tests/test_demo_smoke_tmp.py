"""Throwaway smoke: demo run detail carries task_definition and the
run-bound definition-source endpoint serves the eval code anonymously."""
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.services.demo_fixture import load_demo_fixture
from apo.services.demo_workspace import ensure_demo_project_exists


def test_demo_check_source_end_to_end(session: Session, client: TestClient) -> None:
    assert ensure_demo_project_exists(session) is True
    assert load_demo_fixture(session) is True
    session.commit()

    run_id = "demo-run_1aa53446efa38262b9665b80"
    detail = client.get(f"/v1/agent-task-runs/{run_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    task_definition = body["task_definition"]
    assert task_definition and task_definition["files"], body.get("task_definition")
    file_path = task_definition["files"][0]["path"]
    assert file_path == "dabstep-top-ip-country-for-fraud.eval.ts"

    source = client.get(
        "/v1/task-definition-source",
        params={"task_run_id": run_id, "file_path": file_path},
    )
    assert source.status_code == 200, source.text
    content = source.json()["content"]
    assert 'check("computed-via-python"' in content
    assert 'check("answer-matches-benchmark"' in content
    print("SMOKE OK: definition served,", len(content), "chars")
