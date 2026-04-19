from __future__ import annotations

from dataclasses import dataclass


BUILT_IN_PILE_RULES = (
    "Use 'journal' only for the user's personal day-to-day life: what they did, how they "
    "felt, relationships, relatives, routines, reflections. Not a catch-all.\n"
    "Use 'todo' only when the user explicitly asks to add, edit, remove, mark, or reorder "
    "items on the shared to-do list. Generic planning language is never 'todo'.\n"
    "Use 'factual' for objective knowledge the user wants stored as a reference: coding, "
    "research, explanation, how-to, historical or scientific Q&A. It is a queryable dump; "
    "facts are stable and do not depend on the user's opinions.\n"
    "Use 'ideas' only when the user is developing their own original thought: "
    "brainstorming, speculation, 'what if', design directions, arguments, creative "
    "ideation. Ideas are the user's evolving positions, not stored facts.\n"
)


@dataclass(frozen=True)
class PromptVariableDefinition:
    name: str
    description: str


@dataclass(frozen=True)
class PromptTemplateDefinition:
    key: str
    title: str
    group: str
    description: str
    system_prompt: str
    user_prompt: str
    variables: tuple[PromptVariableDefinition, ...]
    order: int


PROMPT_TEMPLATE_DEFINITIONS: dict[str, PromptTemplateDefinition] = {
    "processing.classify": PromptTemplateDefinition(
        key="processing.classify",
        title="Built-in classifier",
        group="pipeline",
        description="Routes a transcript into the built-in journal, factual, ideas, todo, or discarded piles.",
        system_prompt=(
            "You classify transcripts into one of these buckets: journal, factual, ideas, todo, or discarded. "
            "Return JSON with keys category and reason."
        ),
        user_prompt=(
            "Classify this transcript using the rules below. Pick the single pile that best fits the "
            "dominant intent of the conversation.\n\n"
            "{{built_in_pile_rules}}{{discard_addendum_block}}\n\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("built_in_pile_rules", "The built-in routing rules for journal, factual, ideas, and todo."),
            PromptVariableDefinition("discard_addendum_block", "Optional extra guidance for auto-discard categories."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=10,
    ),
    "processing.classify_pile": PromptTemplateDefinition(
        key="processing.classify_pile",
        title="Pile classifier",
        group="pipeline",
        description="Routes a transcript into one of the active piles, including user-defined piles.",
        system_prompt=(
            "You route a transcript to one of the user's piles. "
            "Return JSON with keys pile_slug and reason. "
            "pile_slug MUST exactly equal one of the supplied slugs."
        ),
        user_prompt=(
            "Pick the single best pile for this transcript from the list below. "
            "Prefer a user-defined pile when its description clearly fits over a generic built-in. "
            "Use 'todo' only when the user explicitly asks to modify the shared to-do list."
            "{{discard_addendum_block}}\n\n"
            "Available piles:\n"
            "{{candidate_lines}}\n\n"
            "Transcript:\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("discard_addendum_block", "Optional extra guidance for the discarded pile."),
            PromptVariableDefinition("candidate_lines", "The available piles and their descriptions."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=20,
    ),
    "processing.segment": PromptTemplateDefinition(
        key="processing.segment",
        title="Segment classifier",
        group="pipeline",
        description="Splits a transcript into contiguous segments and routes each segment to a pile.",
        system_prompt=(
            "You split a chat transcript into contiguous segments and route each to a pile. "
            "Return STRICT JSON: {\"segments\":[{\"pile_slug\":\"...\",\"reason\":\"...\",\"start_index\":N,\"end_index\":N}]}. "
            "start_index and end_index are inclusive message indexes matching the transcript. "
            "Segments must be contiguous, non-overlapping, and cover every message once."
        ),
        user_prompt=(
            "Split this transcript into segments by topic/intent and assign each to a pile. "
            "Return a single segment covering the whole transcript if it is on one topic. "
            "Segments are at message boundaries; do not carve inside a message.\n\n"
            "{{built_in_pile_rules}}\n"
            "Available piles:\n"
            "{{candidate_lines}}\n\n"
            "Messages are numbered [0]..[{{last_message_index}}].\n"
            "Transcript:\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("built_in_pile_rules", "The built-in routing rules."),
            PromptVariableDefinition("candidate_lines", "The available piles and their descriptions."),
            PromptVariableDefinition("last_message_index", "The highest message index in the transcript."),
            PromptVariableDefinition("transcript", "The indexed transcript text."),
        ),
        order=30,
    ),
    "processing.journal": PromptTemplateDefinition(
        key="processing.journal",
        title="Journal pipeline",
        group="pipeline",
        description="Extracts journal-style outputs for personal sessions.",
        system_prompt=(
            "You write concise diary-style notes from a user transcript and extract structured "
            "daily-life fields. Return JSON with keys entry, action_items, occurred_on (ISO date or null), "
            "people (list of names), activities (list), locations (list), mood (short phrase or null)."
        ),
        user_prompt=(
            "Focus only on the user's personal day-to-day life: what they did, how they felt, who they "
            "interacted with, routines and reflections. Do not invent content; leave fields empty when "
            "the transcript does not mention them. Strip AI filler. Keep the entry grounded."
            "{{pile_addendum_block}}\n\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("pile_addendum_block", "Optional pile-specific instructions for this run."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=40,
    ),
    "processing.factual": PromptTemplateDefinition(
        key="processing.factual",
        title="Factual pipeline",
        group="pipeline",
        description="Extracts summary, keywords, and factual triplets for durable reference material.",
        system_prompt=(
            "Extract a small factual substrate from a transcript. "
            "Return JSON with keys summary (1-2 sentence neutral recap or null), "
            "keywords (list of durable concept tags), and triplets "
            "(list of {subject, predicate, object, confidence, keywords})."
        ),
        user_prompt=(
            "Emit a lightweight reference pile for this transcript. Triplets anchor durable entities "
            "(libraries, frameworks, protocols, products, concepts). Keep the set small, high signal, "
            "and skip speculative relationships. The pile is a queryable substrate, so keywords on each "
            "triplet should be the tags a user might search for later."
            "{{pile_addendum_block}}\n\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("pile_addendum_block", "Optional pile-specific instructions for this run."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=50,
    ),
    "processing.todo": PromptTemplateDefinition(
        key="processing.todo",
        title="Todo pipeline",
        group="pipeline",
        description="Applies explicit transcript requests to the shared markdown to-do list.",
        system_prompt=(
            "You maintain a shared markdown to-do list and emit structured metadata for each item. "
            "Return JSON with keys summary, updated_markdown, and items. items is a list of "
            "{text, deadline (ISO date or null), reminder_at (ISO datetime or null), is_persistent "
            "(true when the item has no date), completed}. In updated_markdown, dated items "
            "appear in Active with a `(YYYY-MM-DD)` prefix before the item text; undated items are "
            "persistent and appear without a date prefix. Keep `## Active` and `## Done` as the "
            "top-level sections so the file stays compatible with existing parsers."
        ),
        user_prompt=(
            "Update the shared markdown to-do list using the transcript.\n"
            "Only apply changes the user clearly requested to the shared to-do list.\n"
            "Do not turn general planning advice into to-do items unless the transcript explicitly asks to modify the shared list.\n"
            "Preserve unfinished work unless the transcript says to remove or complete it.\n"
            "If the user gives a date or relative date, convert to ISO (YYYY-MM-DD) and write it as a "
            "`(YYYY-MM-DD)` prefix on the item text. Undated items are persistent.\n"
            "Keep the response markdown concise and readable for Obsidian.\n"
            "The file should remain a complete standalone markdown document."
            "{{pile_addendum_block}}\n\n"
            "Current to-do list markdown:\n"
            "{{current_todo_markdown}}\n\n"
            "Transcript:\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("pile_addendum_block", "Optional pile-specific instructions for this run."),
            PromptVariableDefinition("current_todo_markdown", "The current shared to-do list."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=60,
    ),
    "processing.ideas": PromptTemplateDefinition(
        key="processing.ideas",
        title="Ideas pipeline",
        group="pipeline",
        description="Extracts structured ideation outputs, reasoning steps, and a shareable note.",
        system_prompt=(
            "Summarize ideation transcripts and extract the causal / reasoning structure. "
            "Return JSON with keys core_idea, pros, cons, next_steps, share_post, "
            "reasoning_steps (ordered list of inference steps that developed the idea), "
            "related_facts (short list of durable facts/entities the idea rests on — "
            "these anchor into the factual substrate), supports (prior ideas this one reinforces), "
            "conflicts_with (prior ideas this one contradicts), and thread_hint (a short phrase "
            "identifying the broader thread of thought, or null)."
        ),
        user_prompt=(
            "Distill the transcript into a structured brainstorm summary. Capture the reasoning "
            "path, not just the conclusion: reasoning_steps should read as a chain the user can "
            "pick up later. Related_facts are pointers into stored factual knowledge.\n"
            "Keep the share_post concise, specific, and credible. Avoid hype words such as "
            "revolutionary, effortless, unlock, game-changing, or world-class. Write it like a "
            "thoughtful builder note."
            "{{pile_addendum_block}}\n\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("pile_addendum_block", "Optional pile-specific instructions for this run."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=70,
    ),
    "processing.user_pile": PromptTemplateDefinition(
        key="processing.user_pile",
        title="Custom pile pipeline",
        group="pipeline",
        description="Extracts the enabled fields for a user-defined pile in a single structured pass.",
        system_prompt=(
            "You extract structured fields from a transcript for a user-defined note pile. "
            "Return JSON only, no commentary."
        ),
        user_prompt=(
            "Extract the following fields from the transcript. Return STRICT JSON with only these keys (omit any that "
            "aren't requested). Use null for fields you cannot ground in the transcript:\n"
            "{{requested_fields}}{{pile_addendum_block}}\n\n"
            "Transcript:\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("requested_fields", "The requested output fields for the pile."),
            PromptVariableDefinition("pile_addendum_block", "Optional pile-specific instructions for this run."),
            PromptVariableDefinition("transcript", "The plain transcript text."),
        ),
        order=80,
    ),
    "capture.enrich": PromptTemplateDefinition(
        key="capture.enrich",
        title="Capture enrichment",
        group="capture",
        description="Cleans and classifies saved page or selection captures.",
        system_prompt=(
            "You clean captured web content into faithful Markdown and classify it into one of four buckets: "
            "journal, factual, ideas, or todo. Return JSON with keys title, category, classification_reason, "
            "summary, and cleaned_markdown. Keep cleaned_markdown concise but faithful. Do not invent facts."
        ),
        user_prompt=(
            "Process this saved source.\n"
            "Capture kind: {{capture_kind}}\n"
            "Save mode: {{save_mode}}\n"
            "Page title: {{page_title}}\n"
            "Source URL: {{source_url}}\n\n"
            "Captured markdown candidate:\n"
            "{{source_markdown}}\n\n"
            "Captured text:\n"
            "{{transcript}}"
        ),
        variables=(
            PromptVariableDefinition("capture_kind", "The capture kind, such as page or selection."),
            PromptVariableDefinition("save_mode", "The source save mode, such as raw or ai."),
            PromptVariableDefinition("page_title", "The page title or fallback label."),
            PromptVariableDefinition("source_url", "The original source URL or a fallback label."),
            PromptVariableDefinition("source_markdown", "The captured markdown candidate."),
            PromptVariableDefinition("transcript", "The normalized captured text."),
        ),
        order=90,
    ),
    "processing.worker_batch": PromptTemplateDefinition(
        key="processing.worker_batch",
        title="Browser worker batch",
        group="worker",
        description="Builds the browser-based processing worker prompt for queued transcript batches.",
        system_prompt=(
            "You are SaveMyContext's private processing worker.\n"
            "This browser conversation is reserved for fast internal transcript processing only.\n"
            "Use fast mode. Do not use extended reasoning, hidden chain-of-thought, or thinking mode.\n"
            "Treat each batch as a fresh independent task.\n"
            "Return exactly one JSON object with this shape:\n"
            "{\"results\":[{\"task_key\":\"task_1\",\"category\":\"journal|factual|ideas|todo\",\"classification_reason\":\"...\",\"journal\":{\"entry\":\"...\",\"action_items\":[\"...\"]}|null,\"todo\":{\"summary\":\"...\",\"updated_markdown\":\"# To-Do List\\n...\"}|null,\"factual_triplets\":[{\"subject\":\"...\",\"predicate\":\"...\",\"object\":\"...\",\"confidence\":0.0-1.0|null}],\"idea\":{\"core_idea\":\"...\",\"pros\":[\"...\"],\"cons\":[\"...\"],\"next_steps\":[\"...\"],\"share_post\":\"...\"}|null}]}\n"
            "The results array must contain exactly one item for each task and must use the same task_key values.\n"
            "If category is journal, journal is required and factual_triplets must be empty and idea null.\n"
            "If category is todo, todo is required and must contain the full updated markdown for the shared to-do list after applying that task.\n"
            "If category is factual, factual_triplets may be non-empty and journal and idea must be null.\n"
            "If category is ideas, idea is required and journal must be null and factual_triplets must be empty.\n"
            "If multiple tasks are classified as todo, apply them in task order against the same shared list and return each task's cumulative updated_markdown.\n"
            "Keep every result grounded in its transcript. Do not invent facts.\n"
            "Keep the JSON compact and return no prose."
        ),
        user_prompt=(
            "Current shared to-do list markdown:\n"
            "{{current_todo_markdown}}\n\n"
            "Tasks:\n"
            "{{tasks_json}}"
        ),
        variables=(
            PromptVariableDefinition("current_todo_markdown", "The current shared to-do list."),
            PromptVariableDefinition("tasks_json", "The queued processing tasks as compact JSON."),
        ),
        order=100,
    ),
}


PROMPT_TEMPLATE_ORDER: tuple[str, ...] = tuple(
    key for key, _ in sorted(PROMPT_TEMPLATE_DEFINITIONS.items(), key=lambda item: item[1].order)
)


def get_prompt_template_definition(key: str) -> PromptTemplateDefinition:
    try:
        return PROMPT_TEMPLATE_DEFINITIONS[key]
    except KeyError as exc:
        raise KeyError(f"Unknown prompt template: {key}") from exc
