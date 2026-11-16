#!/usr/bin/env node
// TAPI MCP server (T-090). Exposes the tools in tools.js over stdio, for
// use by any MCP-compatible client (Claude Desktop, Claude Code, etc.).
//
// !! UNVERIFIED AGAINST A LIVE INSTALL — same methodology as the LetsFG
// adapters, applied here for the same reason: no network in this sandbox
// means `npm install` was never run and `@modelcontextprotocol/sdk`'s exact
// API was never checked against the actual installed package. The shape
// below (Server class, ListToolsRequestSchema/CallToolRequestSchema request
// handlers, StdioServerTransport) matches the SDK's documented pattern as
// of this writing, but import paths and exact schema names have changed
// between SDK versions before. Run `npm install` and verify
// `node src/mcp/server.js` actually starts before pointing a real MCP
// client at this — do not assume it works from code review alone. This is
// the same "confirm against sandbox before treating as functional"
// discipline applied everywhere else in this codebase.
require("dotenv").config();
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { tools } = require("./tools");

const server = new Server(
  { name: "tapi", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Surface TAPI's own error code/detail (see tapiClient.js) rather than
    // a bare stack trace — the calling LLM needs the same machine-readable
    // signal a REST client's error response would give it.
    return {
      content: [{ type: "text", text: JSON.stringify({ error: true, code: err.code || "MCP_TOOL_ERROR", detail: err.message }) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TAPI MCP server running on stdio"); // stderr, not stdout — stdout is the MCP transport channel itself
}

main().catch((err) => {
  console.error("TAPI MCP server failed to start:", err);
  process.exit(1);
});
