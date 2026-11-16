// Transactional email behind one method: send({ to, subject, text }).
// Transports (MAIL_TRANSPORT):
//   postmark  Postmark's HTTP API. Needs POSTMARK_SERVER_TOKEN and MAIL_FROM (a verified sender/domain).
//   log       prints the message (links included) to the server console: development only
//   memory    keeps messages in an array: tests
// Anything else, or a missing setting, gives null, and account flows that need email answer 503 instead of
// pretending to send. Production never defaults to `log`.
const POSTMARK_URL = "https://api.postmarkapp.com/email";

function createPostmarkMailer({ token, from, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 10_000, messageStream = "outbound", url = POSTMARK_URL }) {
  if (!token || !from) return null;
  return {
    kind: "postmark",
    async send({ to, subject, text }) {
      // Header injection guard: addresses and subjects never legitimately contain line breaks.
      if ([to, subject, from].some((v) => /[\r\n]/.test(String(v)))) throw Object.assign(new Error("Invalid email header"), { code: "MAIL_INVALID" });
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { method: "POST", signal: ctrl.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
          body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, MessageStream: messageStream }) });
      } catch (_) { throw Object.assign(new Error("Email provider unreachable or timed out"), { code: "MAIL_UNREACHABLE" }); }
      finally { clearTimeout(timer); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data.ErrorCode && data.ErrorCode !== 0)) {
        // Deliberately excludes the message body (it contains one-time links) and the token.
        throw Object.assign(new Error(`Email provider rejected the message (HTTP ${res.status}${data.ErrorCode ? `, code ${data.ErrorCode}` : ""})`), { code: "MAIL_REJECTED", status: res.status });
      }
    },
  };
}

function createMailer(transport, opts = {}) {
  if (transport === "log") return { kind: "log", async send(m) { console.log(`[mail:dev] to=${m.to} subject="${m.subject}"\n${m.text}\n`); } };
  if (transport === "memory") { const outbox = []; return { kind: "memory", outbox, async send(m) { outbox.push(m); } }; }
  if (transport === "postmark") return createPostmarkMailer(opts);
  return null;
}

let cached;
function getMailer(env = process.env, fetchImpl) {
  if (cached !== undefined && env === process.env) return cached;
  const t = env.MAIL_TRANSPORT || (env.NODE_ENV === "production" ? "" : "log");
  const m = createMailer(t, { token: env.POSTMARK_SERVER_TOKEN, from: env.MAIL_FROM, fetchImpl, messageStream: env.POSTMARK_MESSAGE_STREAM || "outbound" });
  if (!m && t) console.warn(`[mail] MAIL_TRANSPORT=${t} is not usable (check POSTMARK_SERVER_TOKEN and MAIL_FROM). Email-dependent endpoints will answer 503.`);
  if (env === process.env) cached = m;
  return m;
}
module.exports = { createMailer, createPostmarkMailer, getMailer };
