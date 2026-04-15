export function extractFirstBalancedJsonObject(value: string): string | null {
  const source = value.trim();
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (startIndex < 0) {
      if (character === "{") {
        startIndex = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

export interface ProcessingTaskReference {
  sessionId: string;
  taskKey?: string;
}

interface ParsedProcessingResponse {
  parsed: Record<string, unknown>;
  normalizedTasks: ProcessingTaskReference[];
}

function normalizeExpectedTasks(expectedTasks: string[] | ProcessingTaskReference[]): ProcessingTaskReference[] {
  if (!expectedTasks.length) {
    return [];
  }

  if (typeof expectedTasks[0] === "string") {
    return (expectedTasks as string[])
      .filter(Boolean)
      .map((sessionId, index) => ({
        sessionId,
        taskKey: `task_${index + 1}`
      }));
  }

  return (expectedTasks as ProcessingTaskReference[])
    .filter((task) => Boolean(task.sessionId))
    .map((task, index) => ({
      sessionId: task.sessionId,
      taskKey: task.taskKey || `task_${index + 1}`
    }));
}

function processingJsonError(reason: string): string {
  return `Could not parse the processing response as valid JSON: ${reason}`;
}

function parseProcessingResponseObject(
  responseText: string,
  expectedTasks: string[] | ProcessingTaskReference[]
): { ok: true; value: ParsedProcessingResponse } | { ok: false; error: string } {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: processingJsonError("The reply was empty.")
    };
  }

  const balancedObject = extractFirstBalancedJsonObject(trimmed);
  const candidate = balancedObject ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const reason =
      balancedObject === null
        ? "The reply does not contain a complete JSON object."
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      error: processingJsonError(reason)
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: processingJsonError("The reply must be a JSON object.")
    };
  }

  return {
    ok: true,
    value: {
      parsed: parsed as Record<string, unknown>,
      normalizedTasks: normalizeExpectedTasks(expectedTasks)
    }
  };
}

function exactTaskKeyError(normalizedTasks: ProcessingTaskReference[]): string {
  return processingJsonError(
    `The reply must include exactly these task_keys or session_ids: ${normalizedTasks
      .map((task) => task.taskKey ?? task.sessionId)
      .join(", ")}.`
  );
}

function normalizeBatchResults(
  parsed: Record<string, unknown>,
  normalizedTasks: ProcessingTaskReference[],
  options: {
    allowPartial: boolean;
  }
):
  | {
      ok: true;
      jsonText: string;
      tasks: ProcessingTaskReference[];
    }
  | { ok: false; error: string } {
  const expectedIds = normalizedTasks.map((task) => task.sessionId);
  const taskKeyToSessionId = new Map(normalizedTasks.map((task) => [task.taskKey ?? "", task.sessionId]));
  const results = parsed.results;
  if (!Array.isArray(results) || !results.length) {
    return {
      ok: false,
      error: processingJsonError("The reply must contain a non-empty results array.")
    };
  }

  const normalizedResults: Array<Record<string, unknown>> = [];
  const resolvedIds: string[] = [];
  const resolvedTasks = new Map<string, ProcessingTaskReference>();
  const seenResolvedIds = new Set<string>();

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index] as ({ session_id?: unknown; task_key?: unknown } & Record<string, unknown>) | null;
    const rawSessionId = typeof item?.session_id === "string" ? item.session_id.trim() : "";
    const rawTaskKey = typeof item?.task_key === "string" ? item.task_key.trim() : "";
    let resolvedSessionId = expectedIds.includes(rawSessionId) ? rawSessionId : undefined;

    if (!resolvedSessionId && rawTaskKey && taskKeyToSessionId.has(rawTaskKey)) {
      resolvedSessionId = taskKeyToSessionId.get(rawTaskKey);
    }
    if (!resolvedSessionId && rawSessionId && taskKeyToSessionId.has(rawSessionId)) {
      resolvedSessionId = taskKeyToSessionId.get(rawSessionId);
    }
    if (!resolvedSessionId && expectedIds.length === 1 && results.length === 1) {
      resolvedSessionId = expectedIds[0];
    }

    if (!resolvedSessionId) {
      if (options.allowPartial) {
        continue;
      }
      return {
        ok: false,
        error: exactTaskKeyError(normalizedTasks)
      };
    }

    if (seenResolvedIds.has(resolvedSessionId)) {
      if (options.allowPartial) {
        continue;
      }
      return {
        ok: false,
        error: processingJsonError("The reply contains duplicate task_key or session_id values.")
      };
    }

    seenResolvedIds.add(resolvedSessionId);
    resolvedIds.push(resolvedSessionId);
    const resolvedTask = normalizedTasks.find((task) => task.sessionId === resolvedSessionId) ?? {
      sessionId: resolvedSessionId
    };
    resolvedTasks.set(resolvedSessionId, resolvedTask);
    normalizedResults.push({
      ...(item ?? {}),
      session_id: resolvedSessionId,
      task_key: rawTaskKey || resolvedTask.taskKey || normalizedTasks[index]?.taskKey
    });
  }

  if (!normalizedResults.length) {
    return {
      ok: false,
      error: exactTaskKeyError(normalizedTasks)
    };
  }

  if (!options.allowPartial) {
    const actualIdSet = new Set(resolvedIds);
    if (
      expectedIds.length > 0 &&
      (resolvedIds.length !== expectedIds.length || expectedIds.some((sessionId) => !actualIdSet.has(sessionId)))
    ) {
      return {
        ok: false,
        error: exactTaskKeyError(normalizedTasks)
      };
    }
  }

  return {
    ok: true,
    jsonText: JSON.stringify({
      ...parsed,
      results: normalizedResults
    }),
    tasks: resolvedIds.map((sessionId) => resolvedTasks.get(sessionId) ?? { sessionId })
  };
}

export function normalizeProcessingResponseJson(
  responseText: string,
  expectedTasks: string[] | ProcessingTaskReference[]
): { ok: true; jsonText: string } | { ok: false; error: string } {
  const parsedResult = parseProcessingResponseObject(responseText, expectedTasks);
  if (!parsedResult.ok) {
    return parsedResult;
  }

  const { parsed, normalizedTasks } = parsedResult.value;
  const expectedIds = normalizedTasks.map((task) => task.sessionId);
  if (expectedIds.length > 1 || "results" in parsed) {
    const normalized = normalizeBatchResults(parsed, normalizedTasks, { allowPartial: false });
    if (!normalized.ok) {
      return normalized;
    }
    return {
      ok: true,
      jsonText: normalized.jsonText
    };
  }

  const single = parsed as { category?: unknown; classification_reason?: unknown };
  if (typeof single.category !== "string" || typeof single.classification_reason !== "string") {
    return {
      ok: false,
      error: processingJsonError("The single-session reply is missing required fields.")
    };
  }

  return {
    ok: true,
    jsonText: JSON.stringify(parsed)
  };
}

export function normalizePartialProcessingResponseJson(
  responseText: string,
  expectedTasks: string[] | ProcessingTaskReference[]
): { ok: true; jsonText: string; tasks: ProcessingTaskReference[] } | { ok: false; error: string } {
  const parsedResult = parseProcessingResponseObject(responseText, expectedTasks);
  if (!parsedResult.ok) {
    return parsedResult;
  }

  const { parsed, normalizedTasks } = parsedResult.value;
  const expectedIds = normalizedTasks.map((task) => task.sessionId);
  if (expectedIds.length <= 1 && !("results" in parsed)) {
    const normalized = normalizeProcessingResponseJson(responseText, expectedTasks);
    if (!normalized.ok) {
      return normalized;
    }
    return {
      ok: true,
      jsonText: normalized.jsonText,
      tasks: normalizedTasks
    };
  }

  return normalizeBatchResults(parsed, normalizedTasks, { allowPartial: true });
}

export function buildProcessingRepairPrompt(
  responseText: string,
  errorMessage: string,
  expectedTasks: string[] | ProcessingTaskReference[] = []
): string {
  const normalizedTasks = normalizeExpectedTasks(expectedTasks);
  const sessionHint =
    normalizedTasks.length > 0
      ? [
          "",
          `Expected task_keys: ${normalizedTasks.map((task) => task.taskKey ?? task.sessionId).join(", ")}`,
          "Return one JSON object whose results array contains exactly one item for each of those task_keys.",
          "Do not rename or omit the task_key values."
        ]
      : [];
  return [
    "Your previous reply could not be accepted by SaveMyContext because it was not valid JSON.",
    "Repair it and return exactly one valid JSON object.",
    "Do not include markdown fences, explanations, or any text before or after the JSON.",
    "Preserve the same meaning and schema as the previous reply unless a minimal correction is required.",
    "Return compact minified JSON only.",
    ...sessionHint,
    "",
    `Backend error: ${errorMessage}`,
    "",
    "Previous reply:",
    responseText
  ].join("\n");
}
