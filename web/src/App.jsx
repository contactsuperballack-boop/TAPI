import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi } from "./api.js";
import { Banner, Icon } from "./ui.jsx";
import { AuthScreen, SetPasswordPage, VerifyEmailPage } from "./Auth.jsx";
import { SessionContext, ROLE_LABEL, canManageTeam, isStaff, isTraveller } from "./session.jsx";
import { TripsView } from "./TripsView.jsx";
import { TripView } from "./TripView.jsx";
import { TravellersView } from "./TravellersView.jsx";
import { MyDetails } from "./Profile.jsx";
import { TeamView } from "./Team.jsx";
import { RequestsView } from "./Requests.jsx";

const STORE = "tapi.auth";
const read = () => { try { return JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch (_) { return null; } };
const write = (v) => { try { v ? sessionStorage.setItem(STORE, JSON.stringify(v)) : sessionStorage.removeItem(STORE); } catch (_) { /* private mode */ } };
const API_KEY_PRINCIPAL = { type: "api_key", role: "admin", fullName: "Agency API key", emailVerified: true };

function useHash() {
  const [h, setH] = useState(window.location.hash || "#/trips");
  useEffect(() => { const f = () => setH(window.location.hash || "#/trips"); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  return [h, (to) => { window.location.hash = to; }];
}
const tokenOf = (hash) => { const m = hash.match(/[?&]token=([^&]+)/); return m ? decodeURIComponent(m[1]) : ""; };

function VerifyBanner({ api }) {
  const [msg, setMsg] = useState(null);
  async function resend() { try { await api.resendVerification(); setMsg("Sent. Check your inbox."); } catch (e) { setMsg(e.message); } }
  return <Banner tone="warn">Confirm your email to approve and book trips. We sent you a link. <button className="btn ghost sm" onClick={resend} style={{ marginLeft: 6 }}>Send again</button>{msg && <span className="sub"> {msg}</span>}</Banner>;
}

export default function App() {
  const [auth, setAuth] = useState(read);
  const [principal, setPrincipal] = useState(() => { const a = read(); return a ? (a.kind === "session" ? { type: "session", ...a.principal } : API_KEY_PRINCIPAL) : null; });
  const [hash, go] = useHash();
  const [notice, setNotice] = useState(null);
  const token = auth ? (auth.kind === "session" ? auth.token : auth.key) : "";
  const api = useMemo(() => (token ? createApi({ apiKey: token }) : null), [token]);

  const signOut = useCallback(async (msg) => {
    if (auth && auth.kind === "session") { try { await createApi({ apiKey: auth.token }).logout(); } catch (_) { /* already gone */ } }
    write(null); setAuth(null); setPrincipal(null); setNotice(typeof msg === "string" ? msg : null); go("#/trips");
  }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps
  const onAuthError = useCallback(() => signOut("Your session has ended. Please sign in again."), [signOut]);
  const refreshPrincipal = useCallback(async () => {
    if (!api || !auth || auth.kind !== "session") return;
    try { const me = await api.me(); const p = { ...me }; write({ ...auth, principal: p }); setPrincipal(p); } catch (_) { /* keep what we have */ }
  }, [api, auth]);

  // Login returns the principal without a `type`; /me adds it. Normalise so both paths agree (unverified banner, agent consent).
  function onSession(tok, p0, opts = {}) { const p = { type: "session", ...p0 }; const a = { kind: "session", token: tok, principal: p }; write(a); setAuth(a); setPrincipal(p); setNotice(opts.justSignedUp ? "Account created. We sent a confirmation link to your email. You can plan now, and confirm before booking." : null); go("#/trips"); }
  function onApiKey(key) { const a = { kind: "key", key }; write(a); setAuth(a); setPrincipal(API_KEY_PRINCIPAL); go("#/trips"); }

  // Public pages that work signed in or out.
  if (hash.startsWith("#/verify")) return <VerifyEmailPage token={tokenOf(hash)} go={go} onVerified={refreshPrincipal} />;
  if (hash.startsWith("#/reset")) return <SetPasswordPage token={tokenOf(hash)} go={(h) => { write(null); setAuth(null); setPrincipal(null); go(h); }} />;
  if (!api || !principal) return <>{notice && <div style={{ padding: "16px 16px 0", maxWidth: 460, margin: "0 auto" }}><Banner tone="info" onClose={() => setNotice(null)}>{notice}</Banner></div>}<AuthScreen onSession={onSession} onApiKey={onApiKey} go={go} /></>;

  const staff = isStaff(principal); const trav = isTraveller(principal);
  const nav = trav ? [["trips", "My trips", "trips", "#/trips"], ["profile", "My details", "users", "#/profile"]]
    : [["trips", "Trips", "trips", "#/trips"], ["requests", "Requests", "chat", "#/requests"], ["clients", "Clients", "users", "#/clients"], ...(canManageTeam(principal) ? [["team", "Team", "list", "#/team"]] : [])];
  const m = hash.match(/^#\/trips\/([0-9a-f-]{36})/i);
  const section = hash.startsWith("#/profile") ? "profile" : hash.startsWith("#/clients") || hash.startsWith("#/travellers") ? "clients" : hash.startsWith("#/team") ? "team" : hash.startsWith("#/requests") ? "requests" : "trips";
  const allowed = nav.some((n) => n[0] === section);
  const unverified = principal.type === "session" && !principal.emailVerified;

  return (
    <SessionContext.Provider value={{ api, principal, signOut, refreshPrincipal }}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand"><span className="dot"><Icon name="plane" size={16} /></span>TAPI Agent</div>
          {nav.map(([id, label, icon, to]) => <button key={id} className="navlink" aria-current={section === id ? "page" : undefined} onClick={() => go(to)}><Icon name={icon} />{label}</button>)}
          <div className="spacer" />
          <div className="userbox"><strong>{principal.fullName}</strong>{principal.type === "session" ? `${ROLE_LABEL[principal.role]} · ${principal.agencyName}` : "Agency admin"}</div>
          <button className="navlink" onClick={() => signOut()}>Sign out</button>
        </aside>
        <main className="main">
          <div className="row between mobile-only" style={{ marginBottom: 12 }}>
            <span className="sub"><strong>{principal.fullName}</strong>{principal.type === "session" ? ` · ${ROLE_LABEL[principal.role]}` : ""}</span>
            <button className="btn ghost sm" onClick={() => signOut()}>Sign out</button>
          </div>
          {notice && <div style={{ marginBottom: 12 }}><Banner tone="info" onClose={() => setNotice(null)}>{notice}</Banner></div>}
          {unverified && <div style={{ marginBottom: 12 }}><VerifyBanner api={api} /></div>}
          {!allowed ? <Banner tone="warn">That page is not available for your account.</Banner>
            : m ? <TripView api={api} tripId={m[1]} go={go} onAuthError={onAuthError} />
            : section === "clients" && staff ? <TravellersView api={api} onAuthError={onAuthError} />
            : section === "profile" && trav ? <MyDetails onAuthError={onAuthError} />
            : section === "requests" && staff ? <RequestsView onAuthError={onAuthError} />
            : section === "team" ? <TeamView onAuthError={onAuthError} />
            : <TripsView api={api} go={go} onAuthError={onAuthError} />}
        </main>
        <nav className="tabbar" aria-label="Main">
          {nav.map(([id, label, icon, to]) => <button key={id} aria-current={section === id ? "page" : undefined} onClick={() => go(to)}><Icon name={icon} />{label}</button>)}
        </nav>
      </div>
    </SessionContext.Provider>
  );
}
