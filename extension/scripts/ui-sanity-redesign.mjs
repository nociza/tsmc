import { chromium } from "@playwright/test";
import { resolve } from "node:path";

const extensionDist = resolve("dist");
const backendBaseUrl = "http://127.0.0.1:18888";
const userDataDir = resolve(".playwright-redesign-user");

const sessions = [
  {
    id: "s1",
    provider: "chatgpt",
    external_session_id: "ctx-001",
    title: "Context engineering notes",
    category: "factual",
    custom_tags: ["context"],
    user_categories: ["Architecture Review"],
    markdown_path: "factual/context-engineering-notes.md",
    share_post: "Working notes on persistent context surfaces and retrieval boundaries.",
    updated_at: "2026-04-11T17:30:00Z",
    last_captured_at: "2026-04-11T17:30:00Z",
    last_processed_at: "2026-04-11T17:32:00Z"
  },
  {
    id: "s2",
    provider: "gemini",
    external_session_id: "ctx-002",
    title: "Knowledge graph management",
    category: "factual",
    custom_tags: ["graph"],
    user_categories: ["Architecture Review", "Knowledge Ops"],
    markdown_path: "factual/knowledge-graph-management.md",
    share_post: "Design notes on graph coverage, provenance, and maintenance loops.",
    updated_at: "2026-04-12T20:15:00Z",
    last_captured_at: "2026-04-12T20:15:00Z",
    last_processed_at: "2026-04-12T20:17:00Z"
  },
  {
    id: "s3",
    provider: "grok",
    external_session_id: "ctx-003",
    title: "Retrieval diagnostics",
    category: "factual",
    custom_tags: ["retrieval"],
    user_categories: ["Knowledge Ops"],
    markdown_path: "factual/retrieval-diagnostics.md",
    share_post: "How to trace missing evidence and disconnected entities.",
    updated_at: "2026-04-13T09:45:00Z",
    last_captured_at: "2026-04-13T09:45:00Z",
    last_processed_at: "2026-04-13T09:48:00Z"
  },
  {
    id: "s4",
    provider: "chatgpt",
    external_session_id: "ctx-004",
    title: "Atlas and storyline surfaces",
    category: "factual",
    custom_tags: ["story"],
    user_categories: ["Knowledge Ops"],
    markdown_path: "factual/atlas-and-storyline-surfaces.md",
    share_post: "Atlas view should support cluster navigation and guided exploration.",
    updated_at: "2026-04-14T11:10:00Z",
    last_captured_at: "2026-04-14T11:10:00Z",
    last_processed_at: "2026-04-14T11:14:00Z"
  },
  {
    id: "s5",
    provider: "gemini",
    external_session_id: "ctx-005",
    title: "Temporal memory patterns",
    category: "factual",
    custom_tags: ["memory"],
    user_categories: ["Memory Lab"],
    markdown_path: "factual/temporal-memory-patterns.md",
    share_post: "Timeline filters reveal how concepts evolve across sessions.",
    updated_at: "2026-04-15T16:40:00Z",
    last_captured_at: "2026-04-15T16:40:00Z",
    last_processed_at: "2026-04-15T16:42:00Z"
  },
  {
    id: "s6",
    provider: "chatgpt",
    external_session_id: "ctx-006",
    title: "Karpathy LLM wiki patterns",
    category: "factual",
    custom_tags: ["wiki"],
    user_categories: ["Knowledge Ops", "Research"],
    markdown_path: "factual/karpathy-llm-wiki-patterns.md",
    share_post: "Index, sync, log, lint, and query should be first-class graph management surfaces.",
    updated_at: "2026-04-16T08:05:00Z",
    last_captured_at: "2026-04-16T08:05:00Z",
    last_processed_at: "2026-04-16T08:09:00Z"
  },
  {
    id: "t1",
    provider: "chatgpt",
    external_session_id: "todo-001",
    title: "Sprint checklist cleanup",
    category: "todo",
    custom_tags: ["shared-list"],
    user_categories: ["Launch"],
    markdown_path: "todo/sprint-checklist-cleanup.md",
    share_post: "Closed two stale tasks and reopened release notes for final review.",
    todo_summary: "Checked off 'Archive stale branches' and reopened 'Review release notes'.",
    updated_at: "2026-04-16T10:15:00Z",
    last_captured_at: "2026-04-16T10:15:00Z",
    last_processed_at: "2026-04-16T10:18:00Z"
  },
  {
    id: "t2",
    provider: "gemini",
    external_session_id: "todo-002",
    title: "Product launch board",
    category: "todo",
    custom_tags: ["launch"],
    user_categories: ["Launch", "Operations"],
    markdown_path: "todo/product-launch-board.md",
    share_post: "Added the rollout checklist and marked launch copy review complete.",
    todo_summary: "Added 'Dry run launch email' and marked 'Review launch copy' done.",
    updated_at: "2026-04-16T12:40:00Z",
    last_captured_at: "2026-04-16T12:40:00Z",
    last_processed_at: "2026-04-16T12:42:00Z"
  }
];

const notes = Object.fromEntries(
  sessions.map((session, index) => [
    session.id,
    {
      ...session,
      source_url: `https://example.com/${session.id}`,
      classification_reason: "Mocked for browser sanity check",
      journal_entry: null,
      todo_summary: session.todo_summary ?? null,
      idea_summary: null,
      created_at: session.updated_at,
      messages: [
        {
          id: `${session.id}-m1`,
          external_message_id: `${session.id}-ext-1`,
          role: "user",
          content: `What matters most about ${session.title}?`,
          sequence_index: 0,
          created_at: session.updated_at
        },
        {
          id: `${session.id}-m2`,
          external_message_id: `${session.id}-ext-2`,
          role: "assistant",
          content: session.share_post,
          sequence_index: 1,
          created_at: session.updated_at
        }
      ],
      triplets:
        session.category === "factual"
          ? [
              {
                id: `${session.id}-t1`,
                subject: session.title.split(" ")[0],
                predicate: "relates_to",
                object: "Context",
                created_at: session.updated_at
              }
            ]
          : [],
      raw_markdown: `# ${session.title}

${session.todo_summary ?? session.share_post}

## Why it matters

- Persistent context needs shape
- Retrieval should be inspectable
- Notes need evidence and provenance`,
      related_entities: session.category === "factual" ? ["Context", "Retrieval", "Memory"] : [],
      word_count: 180 + index * 14
    }
  ])
);

const fullGraph = {
  category: "factual",
  node_count: 7,
  edge_count: 8,
  nodes: [
    {
      id: "n1",
      label: "Context",
      kind: "concept",
      size: 7,
      session_ids: ["s1", "s2", "s4", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n2",
      label: "Knowledge Graph",
      kind: "system",
      size: 5,
      session_ids: ["s2", "s3", "s4"],
      provider: "gemini",
      updated_at: "2026-04-14T11:10:00Z"
    },
    {
      id: "n3",
      label: "Retrieval",
      kind: "workflow",
      size: 5,
      session_ids: ["s1", "s3", "s5"],
      provider: "grok",
      updated_at: "2026-04-15T16:40:00Z"
    },
    {
      id: "n4",
      label: "Memory",
      kind: "concept",
      size: 4,
      session_ids: ["s1", "s5", "s6"],
      provider: "gemini",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n5",
      label: "Storyline",
      kind: "pattern",
      size: 3,
      session_ids: ["s4", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n6",
      label: "Lint",
      kind: "operation",
      size: 3,
      session_ids: ["s2", "s6"],
      provider: "chatgpt",
      updated_at: "2026-04-16T08:05:00Z"
    },
    {
      id: "n7",
      label: "Orphan evidence",
      kind: "signal",
      size: 1,
      session_ids: ["s3"],
      provider: "grok",
      updated_at: "2026-04-13T09:45:00Z"
    }
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", label: "organizes", weight: 4, session_ids: ["s2", "s4"] },
    { id: "e2", source: "n1", target: "n3", label: "requires", weight: 3, session_ids: ["s1", "s3"] },
    { id: "e3", source: "n3", target: "n4", label: "grounds", weight: 4, session_ids: ["s3", "s5"] },
    { id: "e4", source: "n1", target: "n4", label: "preserves", weight: 3, session_ids: ["s1", "s5", "s6"] },
    { id: "e5", source: "n5", target: "n1", label: "narrates", weight: 2, session_ids: ["s4", "s6"] },
    { id: "e6", source: "n6", target: "n2", label: "audits", weight: 3, session_ids: ["s2", "s6"] },
    { id: "e7", source: "n6", target: "n3", label: "checks", weight: 2, session_ids: ["s3", "s6"] },
    { id: "e8", source: "n5", target: "n3", label: "guides", weight: 2, session_ids: ["s4", "s5"] }
  ]
};

const sharedTodo = {
  title: "To-Do List",
  content: `# To-Do List

## Active
- [ ] Dry run launch email
- [ ] Review release notes
- [ ] Ship popup polish

## Done
- [x] Archive stale branches
- [x] Review launch copy
`,
  items: [
    { text: "Dry run launch email", done: false },
    { text: "Review release notes", done: false },
    { text: "Ship popup polish", done: false },
    { text: "Archive stale branches", done: true },
    { text: "Review launch copy", done: true }
  ],
  active_count: 3,
  completed_count: 2,
  total_count: 5,
  git: {
    versioning_enabled: true,
    available: true,
    repository_ready: true,
    branch: "main",
    clean: true,
    last_commit_message: "Check off checklist items",
    last_commit_at: "2026-04-16T13:05:00Z"
  }
};

function dominantCategory(availableSessions, fallback = "factual") {
  const counts = new Map();
  for (const session of availableSessions) {
    if (!session.category) {
      continue;
    }
    counts.set(session.category, (counts.get(session.category) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

function pathUserCategory(url) {
  const marker = "/custom-categories/";
  const index = url.pathname.indexOf(marker);
  if (index < 0) {
    return null;
  }
  const tail = url.pathname.slice(index + marker.length);
  const name = tail.split("/")[0] ?? "";
  return name ? decodeURIComponent(name) : null;
}

function scopeLabel(url) {
  return url.searchParams.get("user_category") ?? pathUserCategory(url) ?? url.searchParams.get("category") ?? "factual";
}

function summarizeUserCategories(availableSessions) {
  const counts = new Map();
  for (const session of availableSessions) {
    for (const category of session.user_categories ?? []) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function filteredSessions(url) {
  const provider = url.searchParams.get("provider");
  const category = url.searchParams.get("category");
  const userCategory = url.searchParams.get("user_category") ?? pathUserCategory(url);
  return sessions.filter(
    (session) =>
      (!provider || session.provider === provider) &&
      (!category || session.category === category) &&
      (!userCategory || (session.user_categories ?? []).includes(userCategory))
  );
}

function buildSessionGraph(availableSessions, category) {
  const nodes = availableSessions.map((session, index) => ({
    id: session.id,
    label: session.title,
    kind: "session",
    size: 2 + (session.user_categories?.length ?? 0),
    session_ids: [session.id],
    provider: session.provider,
    category: session.category,
    updated_at: session.updated_at,
    note_path: session.markdown_path,
    x: index
  }));
  const edges = [];

  for (let index = 0; index < availableSessions.length; index += 1) {
    for (let inner = index + 1; inner < availableSessions.length; inner += 1) {
      const left = availableSessions[index];
      const right = availableSessions[inner];
      const leftTags = new Set([...(left.custom_tags ?? []), ...(left.user_categories ?? [])]);
      const sharedLabels = [...new Set([...(right.custom_tags ?? []), ...(right.user_categories ?? [])])].filter((value) => leftTags.has(value));
      if (!sharedLabels.length && left.provider !== right.provider) {
        continue;
      }
      edges.push({
        id: `${left.id}-${right.id}`,
        source: left.id,
        target: right.id,
        label: sharedLabels[0] ?? "provider",
        weight: Math.max(sharedLabels.length, 1),
        session_ids: [left.id, right.id]
      });
    }
  }

  return {
    category,
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges
  };
}

function filteredGraph(url) {
  const availableSessions = filteredSessions(url);
  const dominant = dominantCategory(availableSessions, url.searchParams.get("category") ?? "factual");
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const hasScope = scopedIds.size > 0;
  const allowedSessionIds = new Set(availableSessions.map((session) => session.id));
  const sessionAllowed = (sessionId) => allowedSessionIds.has(sessionId) && (!hasScope || scopedIds.has(sessionId));

  let graphBody;
  if ((url.searchParams.get("user_category") || dominant !== "factual") && availableSessions.length) {
    const scopedSessions = hasScope ? availableSessions.filter((session) => scopedIds.has(session.id)) : availableSessions;
    graphBody = buildSessionGraph(scopedSessions, dominant);
  } else if ((url.searchParams.get("category") ?? "factual") !== "factual") {
    graphBody = {
      category: url.searchParams.get("category") ?? "factual",
      node_count: 0,
      edge_count: 0,
      nodes: [],
      edges: []
    };
  } else {
    const nodes = fullGraph.nodes.filter((node) => node.session_ids.some(sessionAllowed));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = fullGraph.edges.filter(
      (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.session_ids.some(sessionAllowed)
    );

    graphBody = {
      category: dominant,
      node_count: nodes.length,
      edge_count: edges.length,
      nodes,
      edges
    };
  }

  return {
    ...graphBody,
    scope_kind: url.searchParams.get("user_category") ? "custom" : "default",
    scope_label: scopeLabel(url),
    dominant_category: dominant
  };
}

function buildStats(url) {
  const availableSessions = filteredSessions(url);
  const category = dominantCategory(availableSessions, url.searchParams.get("category") ?? "factual");
  const scopedIds = new Set(url.searchParams.getAll("session_id"));
  const visibleSessions = scopedIds.size
    ? availableSessions.filter((session) => scopedIds.has(session.id))
    : availableSessions;
  const graph = filteredGraph(url);
  const providerCounts = ["chatgpt", "gemini", "grok"]
    .map((provider) => ({
      provider,
      count: visibleSessions.filter((session) => session.provider === provider).length
    }))
    .filter((item) => item.count > 0);
  const activityMap = new Map();
  for (const session of visibleSessions) {
    const bucket = session.updated_at.slice(0, 10);
    activityMap.set(bucket, (activityMap.get(bucket) ?? 0) + 1);
  }
  const systemCategoryCounts = Array.from(
    visibleSessions.reduce((counts, session) => counts.set(session.category, (counts.get(session.category) ?? 0) + 1), new Map()).entries()
  ).map(([name, count]) => ({ category: name, count }));
  const entityCounts = graph.nodes
    .map((node) => ({ label: node.label, count: node.session_ids.length }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
  const predicateCounts = new Map();
  for (const edge of graph.edges) {
    predicateCounts.set(edge.label ?? "related", (predicateCounts.get(edge.label ?? "related") ?? 0) + edge.weight);
  }

  return {
    category,
    scope_kind: url.searchParams.get("user_category") ? "custom" : "default",
    scope_label: scopeLabel(url),
    dominant_category: category,
    total_sessions: visibleSessions.length,
    total_messages: visibleSessions.length * 24,
    total_triplets: category === "factual" ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) : 0,
    latest_updated_at: visibleSessions[0]?.updated_at ?? null,
    avg_messages_per_session: visibleSessions.length ? 24 : 0,
    avg_triplets_per_session: visibleSessions.length
      ? (category === "factual" ? graph.edges.reduce((sum, edge) => sum + edge.weight, 0) : 0) / visibleSessions.length
      : 0,
    notes_with_share_post: visibleSessions.filter((session) => session.share_post).length,
    notes_with_idea_summary: 0,
    notes_with_journal_entry: 0,
    notes_with_todo_summary: visibleSessions.filter((session) => session.category === "todo" && session.todo_summary).length,
    system_category_counts: systemCategoryCounts,
    provider_counts: providerCounts,
    activity: Array.from(activityMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => ({ bucket, count })),
    top_tags: Array.from(
      visibleSessions
        .flatMap((session) => session.custom_tags)
        .reduce((counts, tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1), new Map())
        .entries()
    ).map(([label, count]) => ({ label, count })),
    top_entities: category === "factual" ? entityCounts : [],
    top_predicates:
      category === "factual"
        ? Array.from(predicateCounts.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((left, right) => right.count - left.count)
        : []
  };
}

function buildSearch(url) {
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const results = filteredSessions(url)
    .filter((session) => session.title.toLowerCase().includes(query) || session.share_post.toLowerCase().includes(query))
    .map((session) => ({
      kind: "session",
      title: session.title,
      snippet: session.share_post,
      session_id: session.id,
      category: session.category,
      provider: session.provider,
      user_categories: session.user_categories ?? [],
      markdown_path: session.markdown_path
    }));

  return { query, count: results.length, results };
}

function buildDashboardSummary() {
  const categories = ["factual", "ideas", "journal", "todo"].map((category) => ({
    category,
    count: sessions.filter((session) => session.category === category).length
  }));
  return {
    total_sessions: sessions.length,
    total_messages: sessions.length * 24,
    total_triplets: fullGraph.edges.reduce((sum, edge) => sum + edge.weight, 0),
    total_sync_events: sessions.length,
    active_tokens: 0,
    latest_sync_at: sessions.map((session) => session.updated_at).sort().at(-1),
    categories,
    custom_categories: summarizeUserCategories(sessions)
  };
}

function buildSystemStatus() {
  return {
    product: "savemycontext",
    version: "0.2.0",
    server_time: new Date().toISOString(),
    markdown_root: "/tmp/mock-markdown",
    vault_root: "/tmp/mock-vault/SaveMyContext",
    todo_list_path: "/tmp/mock-vault/SaveMyContext/Dashboards/To-Do List.md",
    public_url: null,
    auth_mode: "bootstrap_local",
    git_versioning_enabled: true,
    git_available: true,
    total_sessions: sessions.length,
    total_messages: sessions.length * 24,
    total_triplets: fullGraph.edges.reduce((sum, edge) => sum + edge.weight, 0)
  };
}

function buildGraphNodes() {
  return fullGraph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    degree: node.size,
    note_path: null
  }));
}

function buildGraphEdges() {
  return fullGraph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    predicate: edge.label,
    support_count: edge.weight,
    session_ids: edge.session_ids
  }));
}

function attachDebug(page, label) {
  page.on("console", (message) => {
    console.log(`[${label}:console:${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(`[${label}:pageerror] ${error?.stack || error}`);
  });
}

async function main() {
  console.log("launching-context");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1200 },
    args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`]
  });

  try {
    console.log("routing-backend");
    await context.route(`${backendBaseUrl}/api/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      let body;

      if (url.pathname.endsWith("/meta/capabilities")) {
        body = {
          product: "savemycontext",
          version: "0.2.0",
          api_prefix: "/api/v1",
          server_time: new Date().toISOString(),
          auth: {
            mode: "bootstrap_local",
            token_verify_path: "/api/v1/auth/verify",
            local_unauthenticated_access: true,
            remote_requires_token: false
          },
          extension: {
            min_version: "0.1.0",
            auth_mode: "bootstrap_local"
          },
          features: {
            ingest: true,
            search: true,
            graph: true,
            obsidian_vault: true,
            knowledge_graph_files: true,
            storage_management: true,
            agent_api: true,
            browser_proxy: true,
            openai_compatible_api: true
          },
          storage: {
            markdown_root: "/tmp/mock-markdown",
            vault_root: "/tmp/mock-vault",
            public_url: null
          }
        };
      } else if (url.pathname.endsWith("/processing/status")) {
        body = { enabled: true, mode: "immediate", worker_model: "mock-worker", pending_count: 0 };
      } else if (url.pathname.endsWith("/dashboard/summary")) {
        body = buildDashboardSummary();
      } else if (url.pathname.endsWith("/system/status")) {
        body = buildSystemStatus();
      } else if (url.pathname.endsWith("/graph/nodes")) {
        body = buildGraphNodes();
      } else if (url.pathname.endsWith("/graph/edges")) {
        body = buildGraphEdges();
      } else if (url.pathname.endsWith("/todo")) {
        body = sharedTodo;
      } else if (url.pathname.endsWith("/user-categories")) {
        body = summarizeUserCategories(filteredSessions(url));
      } else if (url.pathname.includes("/sessions/") && url.pathname.endsWith("/user-categories")) {
        const sessionId = decodeURIComponent(url.pathname.split("/").slice(-2, -1)[0] ?? "");
        const session = sessions.find((item) => item.id === sessionId);
        const payload = route.request().postDataJSON?.() ?? {};
        const nextCategories = Array.isArray(payload.user_categories) ? payload.user_categories.filter(Boolean) : [];
        if (!session) {
          await route.fulfill({ status: 404, body: "not found" });
          return;
        }
        session.user_categories = [...new Set(nextCategories)];
        if (notes[session.id]) {
          notes[session.id].user_categories = [...session.user_categories];
        }
        body = session;
      } else if (url.pathname.endsWith("/sessions")) {
        body = filteredSessions(url);
      } else if (url.pathname.includes("/custom-categories/") && url.pathname.endsWith("/stats")) {
        body = buildStats(url);
      } else if (url.pathname.includes("/custom-categories/") && url.pathname.endsWith("/graph")) {
        body = filteredGraph(url);
      } else if (url.pathname.includes("/categories/") && url.pathname.endsWith("/stats")) {
        body = buildStats(url);
      } else if (url.pathname.includes("/categories/") && url.pathname.endsWith("/graph")) {
        body = filteredGraph(url);
      } else if (url.pathname.endsWith("/search")) {
        body = buildSearch(url);
      } else if (url.pathname.includes("/notes/")) {
        const sessionId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        body = notes[sessionId];
      } else {
        await route.fulfill({ status: 404, body: "not found" });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      console.log("waiting-service-worker");
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = serviceWorker.url().split("/")[2] ?? "";
    console.log(`extension-id:${extensionId}`);

    const optionsPage = await context.newPage();
    attachDebug(optionsPage, "options");
    console.log("configuring-options");
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
    await optionsPage.locator("#backend-url").fill(backendBaseUrl);
    await optionsPage.locator("#provider-chatgpt").setChecked(true);
    await optionsPage.locator("#provider-gemini").setChecked(true);
    await optionsPage.locator("#provider-grok").setChecked(true);
    await optionsPage.locator("#settings-form").evaluate((form) => form.requestSubmit());
    await optionsPage.locator("#save-status").waitFor({ state: "visible" });
    console.log("options-saved");

    const popupPage = await context.newPage();
    attachDebug(popupPage, "popup");
    console.log("opening-popup");
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
    await popupPage.locator("text=Context Workspace").waitFor();
    await popupPage.screenshot({ path: "/tmp/smc-popup-redesign.png", fullPage: true });
    console.log("popup-done");

    const dashboardPage = await context.newPage();
    attachDebug(dashboardPage, "dashboard");
    console.log("opening-dashboard");
    await dashboardPage.goto(`chrome-extension://${extensionId}/dashboard.html?view=processing`, {
      waitUntil: "domcontentloaded"
    });
    await dashboardPage.locator("text=Vault readiness").waitFor();
    await dashboardPage.screenshot({ path: "/tmp/smc-dashboard-ops-redesign.png", fullPage: true });
    console.log("dashboard-done");

    const atlasPage = await context.newPage();
    attachDebug(atlasPage, "atlas");
    console.log("opening-atlas");
    await atlasPage.goto(`chrome-extension://${extensionId}/category.html?category=factual`, {
      waitUntil: "domcontentloaded"
    });
    try {
      await atlasPage.locator("text=Knowledge graph workspace").waitFor();
    } catch (error) {
      await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign-failure.png", fullPage: true });
      const bodyText = await atlasPage.locator("body").textContent();
      console.log(`[atlas:body] ${(bodyText ?? "").trim().slice(0, 1000)}`);
      throw error;
    }
    await atlasPage.locator(".react-flow__node").first().waitFor();
    await atlasPage.screenshot({ path: "/tmp/smc-category-atlas-redesign.png", fullPage: true });
    console.log("atlas-done");

    const storyPage = await context.newPage();
    attachDebug(storyPage, "story");
    console.log("opening-story");
    await storyPage.goto(`chrome-extension://${extensionId}/category.html?category=factual&view=story`, {
      waitUntil: "domcontentloaded"
    });
    await storyPage.locator("text=Recent note movement").waitFor();
    await storyPage.screenshot({ path: "/tmp/smc-category-story-redesign.png", fullPage: true });
    console.log("story-done");

    const opsPage = await context.newPage();
    attachDebug(opsPage, "ops");
    console.log("opening-ops");
    await opsPage.goto(`chrome-extension://${extensionId}/category.html?category=factual&view=ops`, {
      waitUntil: "domcontentloaded"
    });
    await opsPage.locator("text=Graph hygiene").waitFor();
    await opsPage.screenshot({ path: "/tmp/smc-category-ops-redesign.png", fullPage: true });
    console.log("ops-done");

    const todoPage = await context.newPage();
    attachDebug(todoPage, "todo");
    console.log("opening-todo");
    await todoPage.goto(`chrome-extension://${extensionId}/category.html?category=todo`, {
      waitUntil: "domcontentloaded"
    });
    await todoPage.locator("text=Shared list workspace").waitFor();
    await todoPage.screenshot({ path: "/tmp/smc-category-todo-redesign.png", fullPage: true });
    console.log("todo-done");

    const customPage = await context.newPage();
    attachDebug(customPage, "custom");
    console.log("opening-custom");
    await customPage.goto(`chrome-extension://${extensionId}/category.html?category=factual&userCategory=Knowledge%20Ops`, {
      waitUntil: "domcontentloaded"
    });
    await customPage.locator("text=Knowledge Ops").first().waitFor();
    await customPage.screenshot({ path: "/tmp/smc-category-custom-redesign.png", fullPage: true });
    console.log("custom-done");

    console.log(
      JSON.stringify({
        popup: "/tmp/smc-popup-redesign.png",
        dashboard: "/tmp/smc-dashboard-ops-redesign.png",
        atlas: "/tmp/smc-category-atlas-redesign.png",
        story: "/tmp/smc-category-story-redesign.png",
        ops: "/tmp/smc-category-ops-redesign.png",
        todo: "/tmp/smc-category-todo-redesign.png",
        custom: "/tmp/smc-category-custom-redesign.png"
      })
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
