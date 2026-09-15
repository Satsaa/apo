"""Run-event type constants shared by the event pipeline and consumers.

A leaf module on purpose: ``run_events`` (the pipeline) and ``automations``
(a consumer) both need these names, and importing one from the other forms
an import cycle.
"""

from __future__ import annotations

EVENT_BATCH_RUN_COMPLETED = "batch_run.completed"
EVENT_BATCH_RUN_FAILED = "batch_run.failed"
EVENT_TASK_RUN_STARTED = "task_run.started"
EVENT_TASK_RUN_COMPLETED = "task_run.completed"
EVENT_TASK_RUN_ERROR = "task_run.error"
EVENT_TASK_RUN_TRACE_CLAIMED = "task_run.trace_claimed"

ALL_EVENT_TYPES = [
    EVENT_BATCH_RUN_COMPLETED,
    EVENT_BATCH_RUN_FAILED,
    EVENT_TASK_RUN_STARTED,
    EVENT_TASK_RUN_COMPLETED,
    EVENT_TASK_RUN_ERROR,
    EVENT_TASK_RUN_TRACE_CLAIMED,
]
