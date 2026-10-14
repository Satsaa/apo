# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""Task Definition Revision service + source route tests."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    TaskDefinitionRevisionDB,
    UserDB,
)
from apo.services.task_definition_revisions import (
    TaskDefinitionValidationError,
    compute_task_definition_digest,
    ensure_task_definition_revision,
    get_definition_for_run,
    read_definition_source,
    to_definition_summary,
)


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _doc(content: str = "task('demo', { adapter: 'a' });\n", path: str = "demo.eval.ts") -> dict:  # pyright: ignore[reportMissingTypeArgument]
    return {"schema_version": 1, "files": [{"path": path, "content": content}]}


class TestDefinitionDigest:
    def test_deterministic(self):
        doc = _doc()
        assert compute_task_definition_digest(doc) == compute_task_definition_digest(doc)

    def test_changes_with_content(self):
        a = compute_task_definition_digest(_doc("task('a');"))
        b = compute_task_definition_digest(_doc("task('b');"))
        assert a != b

    def test_matches_cli_format(self):
        doc = _doc("task('x', { adapter: 'a' });\n")
        digest = compute_task_definition_digest(doc)
        assert digest.startswith("sha256:")
        assert len(digest) == 71  # sha256: + 64 hex


class TestEnsureRevision:
    def test_creates_and_deduplicates(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        doc = _doc()

        rev1 = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=doc)
        rev2 = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=doc)

        assert rev1.id == rev2.id
        assert rev1.content_sha256 == compute_task_definition_digest(doc)
        assert rev1.source_files_json[0]["path"] == "demo.eval.ts"

    def test_changed_source_creates_new_row(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()

        rev1 = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=_doc("v1\n"))
        rev2 = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=_doc("v2\n"))

        assert rev1.id != rev2.id
        assert rev1.content_sha256 != rev2.content_sha256
        # First revision is immutable.
        session.refresh(rev1)
        assert rev1.source_files_json[0]["content"] == "v1\n"


    def test_losing_a_concurrent_insert_reuses_the_winner(self, session, monkeypatch):
        """Two publishes of the same new source race past the lookup; the
        loser hits the unique constraint and must return the winner's row
        with its own transaction still usable."""
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        doc = _doc("raced\n")
        winner = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=doc)
        session.commit()

        class _Miss:
            def first(self):
                return None

        real_exec = session.exec
        calls = {"n": 0}

        def exec_missing_once(statement, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                return _Miss()
            return real_exec(statement, *args, **kwargs)

        monkeypatch.setattr(session, "exec", exec_missing_once)
        session.add(ProjectDB(id="p2", name="P2", created_by="u"))

        loser = ensure_task_definition_revision(session, project_id="p1", task_id="demo", document=doc)
        session.commit()

        assert loser.id == winner.id
        assert session.get(ProjectDB, "p2") is not None
        rows = real_exec(select(TaskDefinitionRevisionDB)).all()
        assert len(rows) == 1


class TestValidation:
    def test_rejects_nul(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        with pytest.raises(TaskDefinitionValidationError):
            ensure_task_definition_revision(session, project_id="p1", task_id="t", document=_doc("hello\0"))

    def test_rejects_path_traversal(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        with pytest.raises(TaskDefinitionValidationError):
            ensure_task_definition_revision(
                session, project_id="p1", task_id="t",
                document={"schema_version": 1, "files": [{"path": "../evil.ts", "content": "x"}]},
            )

    @pytest.mark.parametrize(
        "document",
        [
            {"schema_version": 1, "files": [{"path": "x.eval.ts", "content": "x"}], "extra": "y"},
            {"schema_version": 1, "files": [{"path": "x.eval.ts", "content": "x", "mode": "755"}]},
        ],
    )
    def test_rejects_unknown_keys(self, session, document):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        with pytest.raises(TaskDefinitionValidationError, match="unknown"):
            ensure_task_definition_revision(session, project_id="p1", task_id="t", document=document)

    def test_stores_only_path_and_content(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        rev = ensure_task_definition_revision(session, project_id="p1", task_id="t", document=_doc("x\n"))
        assert rev.source_files_json == [{"path": "demo.eval.ts", "content": "x\n"}]

    def test_rejects_wrong_schema(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        with pytest.raises(TaskDefinitionValidationError):
            ensure_task_definition_revision(
                session, project_id="p1", task_id="t",
                document={"schema_version": 99, "files": [{"path": "x.ts", "content": "x"}]},
            )


class TestReadSource:
    def _seed_run_with_definition(self, session) -> str:
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        rev = ensure_task_definition_revision(
            session, project_id="p1", task_id="demo",
            document=_doc("task('demo', { adapter: 'a' });\n"),
        )
        batch = AgentTaskBatchRunDB(id="bch-1", project="p1", selection_type="task", status="completed", created_at=datetime.now(timezone.utc))
        session.add(batch)
        session.flush()
        run = AgentTaskRunDB(id="run-1", batch_run_id="bch-1", task_id="demo", task_path="demo", task_definition_revision_id=rev.id, status="completed")
        session.add(run)
        session.commit()
        return "run-1"

    def test_reads_source_by_run_id(self, session):
        run_id = self._seed_run_with_definition(session)
        result = read_definition_source(session, task_run_id=run_id, file_path="demo.eval.ts")
        assert result is not None
        assert result["name"] == "demo.eval.ts"
        assert result["language"] == "typescript"
        assert "task('demo'" in result["content"]

    def test_returns_none_for_missing_run(self, session):
        assert read_definition_source(session, task_run_id="nope", file_path="x.ts") is None

    def test_returns_none_for_missing_file(self, session):
        run_id = self._seed_run_with_definition(session)
        assert read_definition_source(session, task_run_id=run_id, file_path="wrong.ts") is None


class TestToSummary:
    def test_summary_excludes_content(self, session):
        session.add(ProjectDB(id="p1", name="P", created_by="u"))
        session.commit()
        rev = ensure_task_definition_revision(
            session, project_id="p1", task_id="demo",
            document=_doc("task('demo', { adapter: 'a' });\n"),
        )
        summary = to_definition_summary(rev)
        assert "content" not in str(summary["files"])
        assert summary["files"][0]["path"] == "demo.eval.ts"
        assert summary["files"][0]["language"] == "typescript"
