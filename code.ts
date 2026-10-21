// --- Read-only SQL tool ------------------------------------------------------

async function executeSqlTool(args: any): Promise<string> {
  const sql = String(args?.sql || "").trim().replace(/;+\s*$/, "");
  if (!sql) return "ERROR: 'sql' argument is required.";
  if (!/^(select|with)\b/i.test(sql)) {
    return "ERROR: This tool is strictly read-only. Only SELECT (or WITH...SELECT) statements are permitted.";
  }
  if (/\b(pg_sleep|pg_terminate_backend|dblink|lo_import|lo_export|copy)\b/i.test(sql)) {
    return "ERROR: Disallowed function detected in query.";
  }

  let client = null as any;
  try {
    client = await dbPool.connect();
  } catch {
    return "ERROR: Database is not connected right now (server running on in-memory cache). Report facts you can verify instead.";
  }

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const wrapped = `SELECT * FROM (${sql}) AS goblin_tool_rows LIMIT 100`;
    const result = await client.query(wrapped);
    await client.query("COMMIT");
    const json = JSON.stringify(result.rows, null, 2);
    return json.length > 4000 ? json.slice(0, 4000) + "\n...[truncated]" : json;
  } catch (err: any) {
    try { await client.query("ROLLBACK"); } catch {}
    return `SQL ERROR: ${err?.message || err}`;
  } finally {
    client.release();
  }
}

// --- Phase 2: run_code via E2B cloud sandbox ---------------------------------

async function executeRunCodeTool(args: any): Promise<string> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    return "ERROR: E2B_API_KEY is not configured on the server. Code execution offline — state that honestly and reason about the code by hand instead.";
  }

  const code = String(args?.code || "");
  if (!code.trim()) return "ERROR: 'code' argument is required.";

  const lang = String(args?.language || "python").toLowerCase();
  const template = lang === "javascript" || lang === "js" || lang === "node" ? "nodejs" : "python3";

  try {
    const { Sandbox } = await import("@e2b/code-interpreter");
    const sandbox: any = await Sandbox.create(template, { apiKey, timeoutMs: 60000 });
    try {
      const execution: any = await sandbox.runCode(code, { timeoutMs: 60000 });
      const stdout = execution.logs?.stdout?.join("\n") || "";
      const stderr = execution.logs?.stderr?.join("\n") || "";
      const runtimeError = execution.error
        ? `${execution.error.name}: ${execution.error.value}\n${execution.error.traceback || ""}`
        : "";

      return JSON.stringify({
        language: template,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
        error: runtimeError.slice(0, 1000) || null,
        exitOk: !execution.error
      }, null, 2);
    } finally {
      await sandbox.kill().catch(() => {});
    }
  } catch (err: any) {
    return `ERROR: Sandbox execution failed: ${err?.message || err}`;
  }
}

function executeTimeTool(): string {
  const now = new Date();
  return JSON.stringify({ utc: now.toISOString(), epochMs: now.getTime() });
}

// Real tool dispatcher used by the agent loop
export async function executeAgentTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "http_request":
      return executeHttpRequestTool(args);
    case "query_jobs_db":
      return executeSqlTool(args);
    case "run_code":
      return executeRunCodeTool(args);
    case "get_current_time":
      return executeTimeTool();
    default:
      return `ERROR: Unknown tool '${name}'.`;
  }
}

// Human-readable one-liner for SSE logs when a tool fires
export function describeToolCall(name: string, args: any): string {
  if (name === "http_request") return `${(args?.method || "GET").toUpperCase()} ${args?.url}`;
  if (name === "query_jobs_db") return String(args?.sql || "").slice(0, 120);
  if (name === "run_code") return `sandbox ${(args?.language || "python")} — ${String(args?.code || "").length} chars`;
  return "executing instrument...";
}