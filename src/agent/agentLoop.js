// Provider-neutral agent turn. The model is injected:
//   model.generate({ system, messages, tools }) -> { text?, toolCalls?: [{ id, name, args }] }
// so the loop (caps, containment, fallback) is testable without any vendor
// and the model choice stays open.
const FALLBACK_TEXT = "I couldn't complete that just now. Nothing has been booked or changed. Please try again in a moment.";
const MAX_TOOL_RESULT_CHARS = 20_000;

const SYSTEM_PROMPT = `You are the TAPI travel planning assistant.
You can search flights and hotels and propose items for the traveller to review. You cannot book, pay, or approve anything; the traveller does that themselves in the app.
Ask for any missing detail (dates, origin, destination) instead of guessing it. Never invent offers, prices, availability or confirmations.
Every price is an estimate until the traveller approves and it is revalidated; say so. Quote prices with their currency.`;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${label} timed out`), { code: "TIMEOUT" })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// opts: { model, toolSpecs, handlers, history, userMessage, maxRounds=6, modelTimeoutMs=30000, toolTimeoutMs=60000, system? }
async function runAgentTurn(opts) {
  const { model, toolSpecs, handlers, history = [], userMessage } = opts;
  const maxRounds = opts.maxRounds ?? 6;
  const messages = [...history, { role: "user", content: userMessage }];
  const traces = [];
  const allowed = new Set(toolSpecs.map((t) => t.name));

  for (let round = 0; round < maxRounds; round++) {
    let out;
    try {
      out = await withTimeout(model.generate({ system: opts.system || SYSTEM_PROMPT, messages, tools: toolSpecs }), opts.modelTimeoutMs ?? 30_000, "model call");
    } catch (err) {
      return { text: FALLBACK_TEXT, degraded: true, reason: err.code || "MODEL_ERROR", messages, traces };
    }
    const calls = out.toolCalls || [];
    if (calls.length === 0) {
      const text = (out.text || "").trim();
      messages.push({ role: "assistant", content: text });
      return { text: text || FALLBACK_TEXT, degraded: !text, messages, traces };
    }
    messages.push({ role: "assistant", content: out.text || "", toolCalls: calls });
    for (const call of calls) {
      const started = Date.now();
      let result; let status = "ok";
      if (!allowed.has(call.name) || typeof handlers[call.name] !== "function") {
        status = "error"; result = { error: `Unknown tool ${call.name}` };
      } else {
        try {
          result = await withTimeout(handlers[call.name](call.args || {}), opts.toolTimeoutMs ?? 60_000, `tool ${call.name}`);
        } catch (err) {
          // Contained: the model sees the error and can recover or ask the user; the turn does not crash.
          status = "error"; result = { error: err.message, code: err.code };
        }
      }
      let content = JSON.stringify(result);
      if (content.length > MAX_TOOL_RESULT_CHARS) content = JSON.stringify({ truncated: true, note: "Result too large; narrow the search." });
      traces.push({ tool: call.name, args: call.args || {}, status, ms: Date.now() - started });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  return { text: FALLBACK_TEXT, degraded: true, reason: "MAX_ROUNDS", messages, traces };
}

module.exports = { runAgentTurn, SYSTEM_PROMPT, FALLBACK_TEXT };
