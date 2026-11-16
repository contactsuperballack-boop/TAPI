// Every price shown to a traveller carries a label derived from supplier
// response state. The model never chooses the label.
//   confirmed  - supplier revalidated this offer at this price just now
//   estimated  - a supplier search result that has not been revalidated
//   unverified - anything else (mock data, model-supplied, third-party, stale)

const SEARCH_RESULT_MAX_AGE_MS = 15 * 60_000;

function labelPrice({ source, validatedAt, retrievedAt, now = new Date() }) {
  if (source === "mock") return "unverified";
  if (source !== "tapi") return "unverified";
  if (validatedAt && now - new Date(validatedAt) <= 5 * 60_000) return "confirmed";
  if (retrievedAt && now - new Date(retrievedAt) <= SEARCH_RESULT_MAX_AGE_MS) return "estimated";
  return "unverified";
}

module.exports = { labelPrice, SEARCH_RESULT_MAX_AGE_MS };
