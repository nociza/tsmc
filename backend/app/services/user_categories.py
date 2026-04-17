from __future__ import annotations

from collections import Counter

from app.models.enums import SessionCategory
from app.services.text import normalize_whitespace


USER_CATEGORY_TAG_PREFIX = "category:"
RESERVED_CATEGORY_NAMES = {category.value for category in SessionCategory}


def normalize_user_category_name(value: str) -> str:
    return normalize_whitespace(value)


def user_category_key(value: str) -> str:
    return normalize_user_category_name(value).casefold()


def is_user_category_tag(tag: str) -> bool:
    return normalize_whitespace(tag).casefold().startswith(USER_CATEGORY_TAG_PREFIX)


def encode_user_category_tag(name: str) -> str:
    cleaned = normalize_user_category_name(name)
    return f"{USER_CATEGORY_TAG_PREFIX}{cleaned}"


def extract_user_categories(tags: list[str] | None) -> list[str]:
    categories: dict[str, str] = {}
    for tag in tags or []:
        cleaned = normalize_whitespace(tag)
        if not cleaned:
            continue
        if not cleaned.casefold().startswith(USER_CATEGORY_TAG_PREFIX):
            continue
        name = normalize_user_category_name(cleaned.split(":", 1)[1] if ":" in cleaned else "")
        if not name:
            continue
        categories[user_category_key(name)] = name
    return sorted(categories.values(), key=str.casefold)


def visible_custom_tags(tags: list[str] | None) -> list[str]:
    cleaned_tags: dict[str, str] = {}
    for tag in tags or []:
        cleaned = normalize_whitespace(tag)
        if not cleaned or is_user_category_tag(cleaned):
            continue
        cleaned_tags[cleaned.casefold()] = cleaned
    return sorted(cleaned_tags.values(), key=str.casefold)


def merge_user_categories(tags: list[str] | None, user_categories: list[str]) -> list[str]:
    merged_tags = visible_custom_tags(tags)
    categories: dict[str, str] = {}
    for category in user_categories:
        cleaned = normalize_user_category_name(category)
        if not cleaned:
            continue
        categories[user_category_key(cleaned)] = cleaned
    return sorted([*merged_tags, *(encode_user_category_tag(name) for name in categories.values())], key=str.casefold)


def has_user_category(tags: list[str] | None, value: str) -> bool:
    target = user_category_key(value)
    if not target:
        return False
    return any(user_category_key(category) == target for category in extract_user_categories(tags))


def summarize_user_categories(tag_sets: list[list[str] | None]) -> list[tuple[str, int]]:
    counter = Counter()
    labels: dict[str, str] = {}
    for tags in tag_sets:
        for category in extract_user_categories(tags):
            key = user_category_key(category)
            counter[key] += 1
            labels[key] = category
    return [(labels[key], counter[key]) for key, _ in counter.most_common()]
