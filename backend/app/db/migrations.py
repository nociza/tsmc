from __future__ import annotations

import json
from uuid import uuid4

from sqlalchemy import inspect, text

from app.services.piles import (
    BUILT_IN_SLUG_TO_CATEGORY,
    CATEGORY_TO_BUILT_IN_SLUG,
    DEFAULT_PILES,
)


def apply_schema_migrations(sync_connection) -> None:
    inspector = inspect(sync_connection)
    table_names = set(inspector.get_table_names())

    if "chat_sessions" in table_names:
        chat_columns = {column["name"] for column in inspector.get_columns("chat_sessions")}
        if "todo_summary" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN todo_summary TEXT")
        if "pile_id" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN pile_id VARCHAR(36)")
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_pile_id ON chat_sessions (pile_id)"
            )
        if "is_discarded" not in chat_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE chat_sessions ADD COLUMN is_discarded BOOLEAN NOT NULL DEFAULT 0"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_chat_sessions_is_discarded ON chat_sessions (is_discarded)"
            )
        if "discarded_reason" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN discarded_reason TEXT")
        if "pile_outputs" not in chat_columns:
            sync_connection.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN pile_outputs JSON")

    if "source_captures" in table_names:
        capture_columns = {column["name"] for column in inspector.get_columns("source_captures")}
        if "pile_id" not in capture_columns:
            sync_connection.exec_driver_sql("ALTER TABLE source_captures ADD COLUMN pile_id VARCHAR(36)")
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_source_captures_pile_id ON source_captures (pile_id)"
            )
        if "is_discarded" not in capture_columns:
            sync_connection.exec_driver_sql(
                "ALTER TABLE source_captures ADD COLUMN is_discarded BOOLEAN NOT NULL DEFAULT 0"
            )
            sync_connection.exec_driver_sql(
                "CREATE INDEX IF NOT EXISTS ix_source_captures_is_discarded ON source_captures (is_discarded)"
            )

    if "piles" in inspector.get_table_names():
        _seed_built_in_piles(sync_connection)
        _backfill_pile_id_from_category(sync_connection)


def _seed_built_in_piles(sync_connection) -> None:
    # SQLAlchemy stores Enum values by NAME (the python enum member name) when
    # `native_enum=False` and no `values_callable` is supplied. We mirror that
    # convention in raw inserts so SQLAlchemy can read the rows back as enums.
    for seed in DEFAULT_PILES:
        existing_id = sync_connection.exec_driver_sql(
            "SELECT id FROM piles WHERE slug = ?",
            (seed.slug,),
        ).scalar()
        if existing_id is not None:
            continue
        sync_connection.execute(
            text(
                """
                INSERT INTO piles (
                    id, slug, name, description, kind, folder_label,
                    attributes, pipeline_config,
                    is_active, is_visible_on_dashboard, sort_order,
                    created_at, updated_at
                ) VALUES (
                    :id, :slug, :name, :description, :kind, :folder_label,
                    :attributes, :pipeline_config,
                    1, :is_visible_on_dashboard, :sort_order,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """
            ),
            {
                "id": str(uuid4()),
                "slug": seed.slug,
                "name": seed.name,
                "description": seed.description,
                "kind": seed.kind.name,
                "folder_label": seed.folder_label,
                "attributes": json.dumps(seed.attributes_list()),
                "pipeline_config": json.dumps(seed.pipeline_config),
                "is_visible_on_dashboard": 1 if seed.is_visible_on_dashboard else 0,
                "sort_order": seed.sort_order,
            },
        )


def _backfill_pile_id_from_category(sync_connection) -> None:
    rows = sync_connection.exec_driver_sql("SELECT slug, id FROM piles").fetchall()
    pile_id_by_slug = {slug: pile_id for slug, pile_id in rows}
    if not pile_id_by_slug:
        return

    for category, slug in CATEGORY_TO_BUILT_IN_SLUG.items():
        pile_id = pile_id_by_slug.get(slug)
        if pile_id is None:
            continue
        sync_connection.execute(
            text(
                "UPDATE chat_sessions SET pile_id = :pile_id "
                "WHERE pile_id IS NULL AND category = :category"
            ),
            {"pile_id": pile_id, "category": category.name},
        )
        sync_connection.execute(
            text(
                "UPDATE source_captures SET pile_id = :pile_id "
                "WHERE pile_id IS NULL AND category = :category"
            ),
            {"pile_id": pile_id, "category": category.name},
        )

    discarded_pile_id = pile_id_by_slug.get("discarded")
    if discarded_pile_id is not None:
        sync_connection.execute(
            text(
                "UPDATE chat_sessions SET is_discarded = 1, pile_id = :pile_id "
                "WHERE category = :category AND is_discarded = 0"
            ),
            {"pile_id": discarded_pile_id, "category": "DISCARDED"},
        )


# Re-exported for callers that want the slug map without importing piles directly.
__all__ = ["apply_schema_migrations", "BUILT_IN_SLUG_TO_CATEGORY"]
