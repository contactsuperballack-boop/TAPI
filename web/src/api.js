// Thin client for TAPI's HTTP API. The agency API key lives in memory + sessionStorage
// (cleared when the tab closes). It is an AGENCY credential, not a traveller login.
export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.detail || body.title)) || `Request failed (${status})`);
    this.status = status;
    this.code = body && body.code;
    this.title = body && body.title;
    this.body = body || {};
  }
}

// Calls that need no credentials: sign-up, sign-in, email verification, password reset.
export function createPublicApi({ baseUrl = "", fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  async function post(path, body) {
    let res;
    try { res = await fetchImpl(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch (_) { throw new ApiError(0, { code: "NETWORK", title: "Network error", detail: "Could not reach the server. Check your connection and try again." }); }
    let data = {}; try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    signup: (b) => post("/v1/account/signup", b),
    login: (b) => post("/v1/account/login", b),
    verifyEmail: (token) => post("/v1/account/verify-email", { token }),
    requestReset: (email) => post("/v1/account/password-reset/request", { email }),
    confirmReset: (token, password) => post("/v1/account/password-reset/confirm", { token, password }),
  };
}

export function createApi({ baseUrl = "", apiKey, fetchImpl = (...a) => globalThis.fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1500, maxPolls = 40 }) {
  async function request(method, path, { body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new ApiError(0, { code: "NETWORK", title: "Network error", detail: "Could not reach the server. Check your connection and try again." });
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  async function search(kind, body, onTick) {
    const s = await request("POST", `/v1/${kind}/search`, { body });
    for (let i = 0; i < maxPolls; i++) {
      const r = await request("GET", `/v1/${kind}/search/${s.searchId}`);
      if (r.status === "completed") return r;
      if (r.status === "failed") throw new ApiError(502, { code: "SEARCH_FAILED", title: "Search failed", detail: "The supplier could not complete this search. Try different dates or airports." });
      if (onTick) onTick(i + 1);
      await sleep(pollMs);
    }
    throw new ApiError(504, { code: "SEARCH_TIMEOUT", title: "Search is taking too long", detail: "Try again in a moment." });
  }

  return {
    request,
    ping: () => request("GET", "/v1/account/me"),
    listTrips: () => request("GET", "/v1/trips").then((r) => r.trips),
    createTrip: (b) => request("POST", "/v1/trips", { body: b }),
    getTrip: (id) => request("GET", `/v1/trips/${id}`),
    patchTrip: (id, b) => request("PATCH", `/v1/trips/${id}`, { body: b }),
    events: (id) => request("GET", `/v1/trips/${id}/events`).then((r) => r.events),
    messages: (id) => request("GET", `/v1/trips/${id}/messages`),
    sendMessage: (id, message) => request("POST", `/v1/trips/${id}/messages`, { body: { message } }),
    addItem: (id, kind, offerId) => request("POST", `/v1/trips/${id}/items`, { body: { kind, offerId } }),
    // Approve exactly the price the user saw. The server rejects any mismatch.
    approve: (tripId, item, { clientConsent, fulfilment, travellerNote } = {}) => request("POST", `/v1/trips/${tripId}/items/${item.id}/approve`, { body: { confirm: true, acknowledgedPrice: Number(item.quoted_price), currency: item.currency, ...(clientConsent ? { clientConsent: true } : {}), ...(fulfilment ? { fulfilment } : {}), ...(travellerNote ? { travellerNote } : {}) } }),
    resolveItem: (tripId, itemId, b) => request("POST", `/v1/trips/${tripId}/items/${itemId}/resolve`, { body: b }),
    cancelRequest: (tripId, itemId) => request("POST", `/v1/trips/${tripId}/items/${itemId}/cancel-request`),
    listRequests: (scope) => request("GET", `/v1/fulfilment?scope=${scope}`).then((r) => r.requests),
    claimRequest: (id) => request("POST", `/v1/fulfilment/${id}/claim`),
    releaseRequest: (id) => request("POST", `/v1/fulfilment/${id}/release`),
    revealTraveller: (id) => request("POST", `/v1/fulfilment/${id}/reveal`),
    completeRequest: (id, b) => request("POST", `/v1/fulfilment/${id}/complete`, { body: b }),
    declineRequest: (id, reason) => request("POST", `/v1/fulfilment/${id}/decline`, { body: { reason } }),
    repriceRequest: (id, b) => request("POST", `/v1/fulfilment/${id}/reprice`, { body: b }),
    book: (tripId, itemId, approvalId) => request("POST", `/v1/trips/${tripId}/items/${itemId}/book`, { body: { approvalId }, idempotencyKey: `ui-book-${approvalId}` }),
    refresh: (tripId, itemId) => request("POST", `/v1/trips/${tripId}/items/${itemId}/refresh`),
    me: () => request("GET", "/v1/account/me"),
    logout: () => request("POST", "/v1/account/logout"),
    resendVerification: () => request("POST", "/v1/account/resend-verification"),
    myProfile: () => request("GET", "/v1/travelers/me"),
    updateMyProfile: (b) => request("PATCH", "/v1/travelers/me", { body: b }),
    updateTraveler: (id, b) => request("PATCH", `/v1/travelers/${id}`, { body: b }),
    listStaff: () => request("GET", "/v1/staff").then((r) => r.staff),
    inviteStaff: (b) => request("POST", "/v1/staff", { body: b }),
    setStaffStatus: (membershipId, status) => request("PATCH", `/v1/staff/${membershipId}`, { body: { status } }),
    listTravelers: () => request("GET", "/v1/travelers").then((r) => r.travelers),
    createTraveler: (b) => request("POST", "/v1/travelers", { body: b }),
    searchFlights: (p, onTick) => search("flights", {
      origin: p.origin.toUpperCase(), destination: p.destination.toUpperCase(), departDate: p.departDate,
      ...(p.returnDate ? { returnDate: p.returnDate } : {}), passengers: { adults: Number(p.adults) || 1 },
    }, onTick),
    searchHotels: (p, onTick) => search("hotels", {
      destination: p.destination, checkIn: p.checkIn, checkOut: p.checkOut, guests: { adults: Number(p.adults) || 1 }, rooms: Number(p.rooms) || 1,
    }, onTick),
  };
}
