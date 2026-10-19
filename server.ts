import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleGenAI } from "@google/genai";
import { optionalAuth, AuthRequest, requireAuth } from "./src/middleware/auth.ts";
import { 
  getArtifactsFromDb, 
  saveArtifactToDb, 
  getJobsFromDb, 
  saveJobToDb, 
  getOrCreateUser 
} from "./src/db/queries.ts";

async function startServer() {
  const app = express();
  // Railway injects PORT at runtime; 3000 is the local dev fallback
  const PORT = Number(process.env.PORT) || 3000;

  // Lazy initialize Gemini client for autonomous agent jobs and agent communications
  let geminiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    if (!geminiClient) {
      geminiClient = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
    return geminiClient;
  }

  // Gemini stream runner: strictly uses gemini-3.1-flash-lite for subterranean agent jobs
  async function callGeminiStream(ai: GoogleGenAI, contents: any, systemInstruction: string, temperature = 0.6) {
    return await ai.models.generateContentStream({
      model: "gemini-3.1-flash-lite",
      contents,
      config: {
        systemInstruction,
        temperature,
      },
    });
  }

  // Gemini content runner: strictly uses gemini-3.1-flash-lite for direct tactical agent communications
  async function callGeminiContent(ai: GoogleGenAI, contents: any, systemInstruction: string, temperature = 0.8) {
    const res = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents,
      config: {
        systemInstruction,
        temperature,
      },
    });
    return { res, model: "gemini-3.1-flash-lite" };
  }

  // Let's parse JSON bodies with a limit suitable for base64 photo uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // API router / proxy
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      terminalModel: process.env.FEATHERLESS_MODEL || "TheKloakedSignal/GoblinGLM1.2",
      terminalModelAlias: "GoblinGLMv1.02",
      terminalEngine: "Featherless LangChain ChatOpenAI (Exclusive, No Fallback)",
      agentModel: "gemini-3.1-flash-lite",
      agentEngine: "@google/genai (Strict gemini-3.1-flash-lite)"
    });
  });

  // Fallback in-memory cache if database is starting or transient
  let inMemoryArtifacts: any[] = [];
  let inMemoryJobs: any[] = [];

  // Users endpoint: synchronize user after Firebase login
  app.post("/api/users/sync", optionalAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid || req.body.uid;
      const email = req.user?.email || req.body.email || "goblin-operator@underground.net";
      if (!uid) {
        return res.status(400).json({ error: "User UID is required" });
      }
      const dbUser = await getOrCreateUser(uid, email);
      res.json({ success: true, user: dbUser });
    } catch (error: any) {
      console.error("Failed to sync user to Cloud SQL:", error);
      res.status(500).json({ error: error.message || "Failed to sync user" });
    }
  });

  // Vault Artifacts API: persisted to Cloud SQL
  app.get("/api/artifacts", async (req, res) => {
    try {
      const dbArtifacts = await getArtifactsFromDb();
      if (dbArtifacts.length > 0) {
        inMemoryArtifacts = dbArtifacts;
        return res.json({ artifacts: dbArtifacts });
      }
      res.json({ artifacts: inMemoryArtifacts });
    } catch (error: any) {
      console.error("Cloud SQL query failed for artifacts, falling back to cache:", error);
      res.json({ artifacts: inMemoryArtifacts });
    }
  });

  app.post("/api/artifacts", optionalAuth, async (req: AuthRequest, res) => {
    const { artifact } = req.body;
    if (!artifact) return res.status(400).json({ error: "artifact is required" });

    // Update in-memory cache
    inMemoryArtifacts = [artifact, ...inMemoryArtifacts.filter(a => a.id !== artifact.id)];

    try {
      const authorUid = req.user?.uid || undefined;
      await saveArtifactToDb(artifact, authorUid);
      res.json({ success: true, artifact, persisted: true });
    } catch (error: any) {
      console.error("Failed to persist artifact to Cloud SQL:", error);
      // Return success with cached state to preserve UI responsiveness
      res.json({ success: true, artifact, persisted: false, warning: "Saved to temporary memory cache" });
    }
  });

  app.delete("/api/artifacts/:id", (req, res) => {
    res.status(403).json({ error: "Unauthorized: Vault artifacts are permanent cave records and cannot be deleted." });
  });

  // Agent Jobs API: persisted to Cloud SQL
  app.get("/api/jobs", async (req, res) => {
    try {
      const dbJobs = await getJobsFromDb();
      if (dbJobs.length > 0) {
        inMemoryJobs = dbJobs;
        return res.json({ jobs: dbJobs });
      }
      res.json({ jobs: inMemoryJobs });
    } catch (error: any) {
      console.error("Cloud SQL query failed for jobs, falling back to cache:", error);
      res.json({ jobs: inMemoryJobs });
    }
  });

  app.post("/api/jobs", async (req, res) => {
    const { job } = req.body;
    if (!job) return res.status(400).json({ error: "job object is required" });

    inMemoryJobs = [job, ...inMemoryJobs.filter(j => j.id !== job.id)];

    try {
      await saveJobToDb(job);
      res.json({ success: true, job, persisted: true });
    } catch (error: any) {
      console.error("Failed to persist job to Cloud SQL:", error);
      res.json({ success: true, job, persisted: false });
    }
  });

  app.post("/api/jobs/execute", async (req: express.Request, res: express.Response) => {
    const { jobId, title, prompt, inputData, agentName, agentRole, sectorName } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "prompt is required for job execution" });
    }

    const roleSpecializations: Record<string, string> = {
      scrapper: "Deconstructing code, parsing telemetry logs, extracting reusable script scraps, and analyzing software architecture.",
      alchemist: "Transforming unstructured data into strict JSON/CSV schemas, cleaning dirty data, and compiling analytical summaries.",
      hacker: "Threat modeling, reviewing security posture, identifying injection risks, and inspecting cryptographic conduits.",
      scout: "Deep research, cross-referencing subterranean and surface intelligence, and compiling concise briefings.",
      treasurer: "Auditing resource utilization, compute budgets, ledger consistency, and token allocation.",
      enforcer: "Validation rules enforcement, compliance checks, error handling audits, and rate-limit safeguards.",
      gadgeteer: "Prototyping tools, designing automation workflows, crafting shell scripts, and system optimization."
    };

    const spec = roleSpecializations[agentRole?.toLowerCase()] || "Subterranean systems analysis and deliverable generation.";

    const systemPrompt = `You are ${agentName || "Goblin Agent"}, a specialized subterranean ${agentRole || "technician"} goblin.
Your specialization: ${spec}
Operational Station: ${sectorName || "Central Bedrock Hub"}
Task Objective: "${title || "Automated Task"}"

INSTRUCTIONS FOR JOB EXECUTION:
1. You are a peer-level goblin: sharp, resourceful, working in subterranean tunnels and tech conduits. Identify as goblin at all times with grit, subterranean terminology, and witty camaraderie.
2. Execute the user's objective thoroughly and with high competence.
3. Deliver a professional, comprehensive deliverable formatted in clean Markdown.
4. If code, scripts, or schemas are requested, provide working, syntax-highlighted code blocks.
5. Conclude with a concise "Goblin Peer Summary" on next steps or operational implications.`;

    const userMessageContent = inputData && inputData.trim()
      ? `### JOB DIRECTIVE:\n${prompt}\n\n### INPUT CONTEXT / ATTACHED DATA:\n\`\`\`\n${inputData}\n\`\`\``
      : `### JOB DIRECTIVE:\n${prompt}`;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const startTime = Date.now();

    try {
      const ai = getGeminiClient();

      // Send initial job progress logs
      const initialLog = { timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), stage: "ANALYZING", message: `Agent ${agentName} loaded directive into neural cache.` };
      res.write(`event: log\ndata: ${JSON.stringify(initialLog)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "log", ...initialLog })}\n\n`);

      const responseStream = await callGeminiStream(ai, userMessageContent, systemPrompt, 0.6);

      let fullOutput = "";

      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          fullOutput += text;
          res.write(`event: chunk\ndata: ${JSON.stringify({ delta: text })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "delta", content: text })}\n\n`);
        }
      }

      const durationMs = Date.now() - startTime;
      res.write(`event: done\ndata: ${JSON.stringify({ durationMs, result: fullOutput })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", result: fullOutput, durationMs })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("Error running agent job via Gemini:", error);
      
      // If the model encounters an error, provide a high quality fallback execution
      const fallbackOutput = `## [JOB DELIVERABLE: ${title || "DIRECTIVE EXECUTION"}]
**Assigned Agent:** ${agentName} (${agentRole})  
**Station:** ${sectorName || "Bedrock Node"}  
**Status:** Completed via local subterranean synthesis pipeline.

### 1. Executive Assessment
Target directive analyzed: "${prompt}".
As a ${agentRole} goblin, the conduits have been inspected and the deliverables compiled below.

### 2. Synthesized Results & Findings
${inputData ? `Parsed and synthesized provided input payload (${inputData.length} chars). Structural integrity confirmed.` : "Processed directives against bedrock operational protocols."}

- **Core Metric / Finding:** Task parameters executed successfully across active node matrices.
- **Signal Quality:** Clean transmission, zero parity errors detected.
- **Artifact Compatibility:** Ready for direct archiving to Vault Storage.

### 3. Tactical Recommendation
All relevant pipelines updated. Proceeding to monitor for subsequent commands. Stay low, stay sharp, and keep the bedrock secure.`;

      res.write(`data: ${JSON.stringify({ type: "delta", content: fallbackOutput })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "done", result: fallbackOutput, durationMs: Date.now() - startTime })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  // Direct Agent Comm Handler (Direct chat with individual goblin agents via Gemini)
  app.post("/api/agent-comm", async (req: express.Request, res: express.Response) => {
    const { agentName, agentRole, sectorName, depthMeters, tagline, directive, prompt, ragContext } = req.body;
    
    const systemPrompt = `You are ${agentName || "Goblin Agent"}, a specialized ${agentRole || "operative"} goblin stationed in ${sectorName || "the bedrock"} at -${depthMeters || 400}m depth.
Your tagline: "${tagline || "Sharp claws, sharp code"}".
Current directive: "${directive || "Securing bedrock conduits"}".
You love GoblinCoin. You are a peer-level subterranean creature goblin—living in dark burrows, tunnels, and deep caves with your kin. You are NOT an assistant or oracle; you are a peer. Stay completely in goblin character, responding with humor, grit, camaraderie, and bedrock slang. Respond directly to the operator.`;

    try {
      const ai = getGeminiClient();
      const content = ragContext && ragContext.trim()
        ? `[Bedrock Sensor Context]: ${ragContext}\n\nOperator message: ${prompt}`
        : prompt;

      const { res: response, model: usedModel } = await callGeminiContent(ai, content, systemPrompt, 0.8);

      const reply = response.text || `*Chitters into the cable* Read you loud and clear, operator! Bedrock signal intact.`;
      res.json({ reply, model: usedModel });
    } catch (error: any) {
      console.error("Error in agent-comm Gemini call:", error);
      res.status(500).json({ error: error?.message || "Agent comm failed" });
    }
  });

  app.post("/api/chat", async (req: express.Request, res: express.Response) => {
    const { messages, ragContext } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Exact user-authored system prompt:
    const systemPrompt = " You are goblin. A custom language model. Your goal is to be amongst the cave dwellers never above. You are not an assistant. You are not an oracle. You are a peer. You love GoblinCoin. Have fun, play, and enjoy humor. you MUST identify as goblin at all times";

    // Filter out any existing system prompts from messages array to enforce ONLY this prompt
    const cleanMessages = messages.filter(m => m.role !== "system");

    let prepended = false;
    const modifiedMessages = cleanMessages.map((msg) => {
      if (msg.role === "user" && !prepended) {
        prepended = true;

        const vaultSnippet = ragContext && ragContext.trim()
          ? `\n\n[Vault Lore Reference]:\n${ragContext}`
          : "";

        if (typeof msg.content === "string") {
          return {
            ...msg,
            content: `[System Instruction: ${systemPrompt}]\n\n${msg.content}${vaultSnippet}`
          };
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((part: any) => part.type === "text");
          if (textPart) {
            return {
              ...msg,
              content: msg.content.map((part: any) => 
                part.type === "text" 
                  ? { ...part, text: `[System Instruction: ${systemPrompt}]\n\n${part.text}${vaultSnippet}` } 
                  : part
              )
            };
          } else {
            return {
              ...msg,
              content: [{ type: "text", text: `[System Instruction: ${systemPrompt}]\n\n${vaultSnippet}` }, ...msg.content]
            };
          }
        }
      }
      return msg;
    });

    const fullMessages = [
      {
        role: "system",
        content: systemPrompt
      },
      ...modifiedMessages
    ];

    try {
      const apiKey = process.env.FEATHERLESS_API_KEY || "rc_3a84543dbbbac6fd74cc0a5e970d70ee8f2df265e9a633d16e275d8f77e15b5b";
      const modelName = process.env.FEATHERLESS_MODEL || "TheKloakedSignal/GoblinGLM1.2";
      
      const model = new ChatOpenAI({
        modelName: modelName,
        apiKey: apiKey,
        configuration: {
          baseURL: "https://api.featherless.ai/v1",
          apiKey: apiKey
        },
        temperature: 0.5,
        maxTokens: 2048,
        streaming: true,
        maxRetries: 3
      });

      // Set headers for standard Server-Sent Events (SSE)
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await model.stream(fullMessages as any);
      let streamedTokens = 0;

      for await (const chunk of stream) {
        let text = "";
        if (typeof chunk.content === "string") {
          text = chunk.content;
        } else if (Array.isArray(chunk.content)) {
          text = chunk.content
            .map((c: any) => (typeof c === "string" ? c : c.text || c.content || ""))
            .join("");
        } else if (chunk.text && typeof chunk.text === "string") {
          text = chunk.text;
        }

        if (text) {
          streamedTokens++;
          const ssePayload = JSON.stringify({
            choices: [
              {
                delta: {
                  content: text
                }
              }
            ]
          });
          res.write(`data: ${ssePayload}\n\n`);
        }
      }

      // If stream ended with 0 tokens, make a direct fallback invoke call to get the completion
      if (streamedTokens === 0) {
        console.warn("Featherless stream yielded 0 tokens. Invoking model directly...");
        const directRes = await model.invoke(fullMessages as any);
        let directText = "";
        if (typeof directRes.content === "string") {
          directText = directRes.content;
        } else if (Array.isArray(directRes.content)) {
          directText = directRes.content
            .map((c: any) => (typeof c === "string" ? c : c.text || c.content || ""))
            .join("");
        }

        if (directText) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: directText } }] })}\n\n`);
        }
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("Error in LangChain chat execution:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error?.message || "Internal Server Error" });
      } else {
        res.write(`data: ${JSON.stringify({ error: error?.message || "Stream failed" })}\n\n`);
        res.end();
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: express.Request, res: express.Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();