// Returns an object with generate({system, messages, tools}) or null when no
// model is configured. No vendor is chosen yet: add an adapter here and set
// AGENT_MODEL_PROVIDER. Until then the messages route answers 503 honestly
// instead of faking a reply.
function getModel(env = process.env) {
  const provider = env.AGENT_MODEL_PROVIDER;
  if (!provider) return null;
  // e.g. if (provider === "anthropic") return require("./models/anthropic").create(env);
  return null;
}
module.exports = { getModel };
