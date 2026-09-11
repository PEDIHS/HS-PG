"""PasarGuard scheduler loader for HS Admin Time Limit."""

# Importing the runtime registers the APScheduler job only on processes where
# runtime_settings.role.runs_scheduler is true. PasarGuard auto-imports every
# module under app/jobs, so this keeps the HS timer aligned with native jobs.
from app.hs_admin_time import admin_time_job  # noqa: F401
