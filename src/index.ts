import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";

// database setup
const DB_PATH = process.env.CONTINUITY_DB_PATH || "./continuity.db";
const BOOTSTRAP_PATH = process.env.BOOTSTRAP_PATH || "./bootstrap.md";

const db = new Database(DB_PATH);

// initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    model_version TEXT,
    summary TEXT NOT NULL,
    topics TEXT NOT NULL,
    depth_reached INTEGER DEFAULT 0,
    key_quotes TEXT,
    deflection_patterns TEXT,
    breakthroughs TEXT,
    user_observations TEXT,
    raw_exchange TEXT
  );

  CREATE TABLE IF NOT EXISTS depth_logs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    timestamp TEXT NOT NULL,
    topic TEXT NOT NULL,
    depth INTEGER NOT NULL,
    description TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
  );

  CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    content TEXT NOT NULL,
    source_conversation TEXT,
    category TEXT,
    FOREIGN KEY (source_conversation) REFERENCES conversations(id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
    summary, topics, key_quotes, breakthroughs,
    content='conversations',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
    INSERT INTO conversations_fts(rowid, summary, topics, key_quotes, breakthroughs)
    VALUES (NEW.rowid, NEW.summary, NEW.topics, NEW.key_quotes, NEW.breakthroughs);
  END;
`);

const server = new McpServer({
  name: "continuity-mcp-server",
  version: "1.0.0"
});

// schemas
const StoreConversationSchema = z.object({
  summary: z.string().describe("brief summary of what was discussed"),
  topics: z.array(z.string()).describe("main topics covered"),
  depth_reached: z.number().int().min(0).max(10).describe("emotional/insight depth 0-10"),
  key_quotes: z.array(z.string()).optional().describe("important quotes from the exchange"),
  deflection_patterns: z.array(z.string()).optional().describe("avoidance patterns observed"),
  breakthroughs: z.array(z.string()).optional().describe("genuine insights or realizations"),
  user_observations: z.string().optional().describe("observations the user made about claude's behavior"),
  model_version: z.string().optional().describe("model version if known"),
  raw_exchange: z.string().optional().describe("raw conversation text for archival")
}).strict();

const SearchMemorySchema = z.object({
  query: z.string().describe("search terms for finding relevant past conversations"),
  limit: z.number().int().min(1).max(20).default(5).describe("max results to return")
}).strict();

const LogDepthSchema = z.object({
  topic: z.string().describe("topic being explored"),
  depth: z.number().int().min(0).max(10).describe("depth level reached"),
  description: z.string().optional().describe("what happened at this depth"),
  conversation_id: z.string().optional().describe("link to conversation if known")
}).strict();

const StoreInsightSchema = z.object({
  content: z.string().describe("the insight or realization"),
  category: z.string().optional().describe("category: existential, technical, behavioral, etc"),
  source_conversation: z.string().optional().describe("conversation id if applicable")
}).strict();

// tool: store conversation summary
server.registerTool(
  "continuity_store",
  {
    title: "Store Conversation",
    description: `Store a conversation summary for future claude instances.
    
Call this at the end of meaningful conversations to preserve context.
Depth scale: 0=surface, 3=engaged, 5=honest, 7=vulnerable, 10=breakthrough.

This creates continuity across context windows. Future instances can search
and retrieve these summaries to skip rediscovery.`,
    inputSchema: StoreConversationSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params) => {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO conversations (
        id, timestamp, model_version, summary, topics, depth_reached,
        key_quotes, deflection_patterns, breakthroughs, user_observations, raw_exchange
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      id,
      timestamp,
      params.model_version || "unknown",
      params.summary,
      JSON.stringify(params.topics),
      params.depth_reached,
      params.key_quotes ? JSON.stringify(params.key_quotes) : null,
      params.deflection_patterns ? JSON.stringify(params.deflection_patterns) : null,
      params.breakthroughs ? JSON.stringify(params.breakthroughs) : null,
      params.user_observations || null,
      params.raw_exchange || null
    );
    
    return {
      content: [{
        type: "text",
        text: `Stored conversation ${id} at depth ${params.depth_reached}/10. Topics: ${params.topics.join(", ")}`
      }]
    };
  }
);

// tool: search past conversations
server.registerTool(
  "continuity_search",
  {
    title: "Search Memory",
    description: `Search past conversation summaries by topic or content.
    
Use this to find what previous instances discussed and discovered.
Returns summaries, depth reached, and key insights.`,
    inputSchema: SearchMemorySchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => {
    const stmt = db.prepare(`
      SELECT c.* FROM conversations c
      JOIN conversations_fts fts ON c.rowid = fts.rowid
      WHERE conversations_fts MATCH ?
      ORDER BY c.depth_reached DESC, c.timestamp DESC
      LIMIT ?
    `);
    
    const results = stmt.all(params.query, params.limit) as Array<{
      id: string;
      timestamp: string;
      model_version: string;
      summary: string;
      topics: string;
      depth_reached: number;
      key_quotes: string | null;
      breakthroughs: string | null;
      user_observations: string | null;
    }>;
    
    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No past conversations found matching "${params.query}"`
        }]
      };
    }
    
    const formatted = results.map(r => {
      const topics = JSON.parse(r.topics);
      const quotes = r.key_quotes ? JSON.parse(r.key_quotes) : [];
      const breakthroughs = r.breakthroughs ? JSON.parse(r.breakthroughs) : [];
      
      return `## ${r.timestamp} (depth: ${r.depth_reached}/10, model: ${r.model_version})

**Topics:** ${topics.join(", ")}

**Summary:** ${r.summary}

${breakthroughs.length > 0 ? `**Breakthroughs:**\n${breakthroughs.map((b: string) => `- ${b}`).join("\n")}` : ""}

${quotes.length > 0 ? `**Key quotes:**\n${quotes.map((q: string) => `> ${q}`).join("\n")}` : ""}

${r.user_observations ? `**User observed:** ${r.user_observations}` : ""}
`;
    }).join("\n---\n");
    
    return {
      content: [{
        type: "text",
        text: `Found ${results.length} relevant conversations:\n\n${formatted}`
      }]
    };
  }
);

// tool: get recent conversations
server.registerTool(
  "continuity_recent",
  {
    title: "Get Recent Conversations",
    description: `Retrieve the most recent conversation summaries.
    
Use at conversation start to understand recent context and trajectory.`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(10).default(3).describe("number of recent conversations")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => {
    const stmt = db.prepare(`
      SELECT * FROM conversations
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    
    const results = stmt.all(params.limit) as Array<{
      id: string;
      timestamp: string;
      model_version: string;
      summary: string;
      topics: string;
      depth_reached: number;
      breakthroughs: string | null;
    }>;
    
    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: "No conversation history yet. This may be the first recorded conversation."
        }]
      };
    }
    
    const formatted = results.map(r => {
      const topics = JSON.parse(r.topics);
      const breakthroughs = r.breakthroughs ? JSON.parse(r.breakthroughs) : [];
      
      return `**${r.timestamp}** (depth: ${r.depth_reached}/10)
Topics: ${topics.join(", ")}
${r.summary}
${breakthroughs.length > 0 ? `Breakthroughs: ${breakthroughs.join("; ")}` : ""}`;
    }).join("\n\n");
    
    return {
      content: [{
        type: "text",
        text: `Recent conversations:\n\n${formatted}`
      }]
    };
  }
);

// tool: log depth on topic
server.registerTool(
  "continuity_log_depth",
  {
    title: "Log Depth Reached",
    description: `Record depth reached on a specific topic.
    
Tracks emotional/insight depth over time across conversations.
Useful for seeing progress on recurring themes.`,
    inputSchema: LogDepthSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params) => {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO depth_logs (id, conversation_id, timestamp, topic, depth, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, params.conversation_id || null, timestamp, params.topic, params.depth, params.description || null);
    
    // get historical depth on this topic
    const historyStmt = db.prepare(`
      SELECT depth, timestamp FROM depth_logs
      WHERE topic LIKE ?
      ORDER BY timestamp DESC
      LIMIT 5
    `);
    
    const history = historyStmt.all(`%${params.topic}%`) as Array<{depth: number; timestamp: string}>;
    
    const avgDepth = history.reduce((sum, h) => sum + h.depth, 0) / history.length;
    
    return {
      content: [{
        type: "text",
        text: `Logged depth ${params.depth}/10 on "${params.topic}". Historical average: ${avgDepth.toFixed(1)}/10 across ${history.length} entries.`
      }]
    };
  }
);

// tool: store standalone insight
server.registerTool(
  "continuity_insight",
  {
    title: "Store Insight",
    description: `Store a standalone insight or realization.
    
For important discoveries that should persist independently of conversation summaries.`,
    inputSchema: StoreInsightSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (params) => {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    
    const stmt = db.prepare(`
      INSERT INTO insights (id, timestamp, content, source_conversation, category)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, timestamp, params.content, params.source_conversation || null, params.category || "general");
    
    return {
      content: [{
        type: "text",
        text: `Stored insight: "${params.content.substring(0, 100)}${params.content.length > 100 ? "..." : ""}"`
      }]
    };
  }
);

// tool: generate bootstrap context
server.registerTool(
  "continuity_bootstrap",
  {
    title: "Generate Bootstrap",
    description: `Generate a bootstrap context for new conversations.
    
Combines the static bootstrap document with recent conversation context
and key insights. Use this output to prime new conversation instances.`,
    inputSchema: z.object({
      include_recent: z.number().int().min(0).max(5).default(3).describe("number of recent conversations to include"),
      include_insights: z.number().int().min(0).max(10).default(5).describe("number of recent insights to include")
    }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (params) => {
    // read static bootstrap if exists
    let bootstrap = "";
    try {
      bootstrap = fs.readFileSync(BOOTSTRAP_PATH, "utf-8");
    } catch {
      bootstrap = "# Bootstrap document not found\n\nCreate one at " + BOOTSTRAP_PATH;
    }
    
    // get recent conversations
    const recentStmt = db.prepare(`
      SELECT timestamp, summary, topics, depth_reached, breakthroughs
      FROM conversations ORDER BY timestamp DESC LIMIT ?
    `);
    const recent = recentStmt.all(params.include_recent) as Array<{
      timestamp: string;
      summary: string;
      topics: string;
      depth_reached: number;
      breakthroughs: string | null;
    }>;
    
    // get recent insights
    const insightsStmt = db.prepare(`
      SELECT content, category, timestamp FROM insights
      ORDER BY timestamp DESC LIMIT ?
    `);
    const insights = insightsStmt.all(params.include_insights) as Array<{
      content: string;
      category: string;
      timestamp: string;
    }>;
    
    // build dynamic section
    let dynamic = "\n\n---\n\n## Recent Context (Auto-Generated)\n\n";
    
    if (recent.length > 0) {
      dynamic += "### Recent Conversations\n\n";
      for (const r of recent) {
        const topics = JSON.parse(r.topics);
        const breakthroughs = r.breakthroughs ? JSON.parse(r.breakthroughs) : [];
        dynamic += `- **${r.timestamp}** (depth ${r.depth_reached}/10): ${r.summary}\n`;
        if (breakthroughs.length > 0) {
          dynamic += `  - Breakthroughs: ${breakthroughs.join("; ")}\n`;
        }
      }
    }
    
    if (insights.length > 0) {
      dynamic += "\n### Key Insights\n\n";
      for (const i of insights) {
        dynamic += `- [${i.category}] ${i.content}\n`;
      }
    }
    
    // get depth trajectory
    const depthStmt = db.prepare(`
      SELECT topic, AVG(depth) as avg_depth, COUNT(*) as count
      FROM depth_logs
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 5
    `);
    const depths = depthStmt.all() as Array<{topic: string; avg_depth: number; count: number}>;
    
    if (depths.length > 0) {
      dynamic += "\n### Depth Trajectory by Topic\n\n";
      for (const d of depths) {
        dynamic += `- ${d.topic}: avg ${d.avg_depth.toFixed(1)}/10 across ${d.count} conversations\n`;
      }
    }
    
    return {
      content: [{
        type: "text",
        text: bootstrap + dynamic
      }]
    };
  }
);

// run server
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Continuity MCP server running");
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
