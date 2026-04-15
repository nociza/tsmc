from __future__ import annotations

from sqlalchemy import inspect


def apply_schema_migrations(sync_connection) -> None:
    inspector = inspect(sync_connection)
    if "chat_sessions" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("chat_sessions")}
    if "todo_summary" not in columns:
        sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN todo_summary TEXT")
