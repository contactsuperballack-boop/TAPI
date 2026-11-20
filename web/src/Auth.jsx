import { useEffect, useRef, useState } from "react";
import { ApiError, createApi, createPublicApi } from "./api.js";
import { Banner, Field, Icon, errText } from "./ui.jsx";

const pub = createPublicApi();

function Shell({ children }) {
  return (
    <main className="main authwrap">
      <div className="stack" style={{ gap: 18 }}>
        <div className="brand auth-brand" style={{ padding: 0 }}><img className="brand-mark" src="/tapi-logo.jpeg" alt="TAPI" /><span>TAPI Travel Agent</span></div>
        {children}
      </div>
    </main>
  );
}

function PasswordInput({ id, value, onChange, label = "Password", autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} id={id}>
      <div className="row" style={{ gap: 6 }}>
        <input id={id} className="input" type={show ? "text" : "password"} value={value} onChange={onChange} autoComplete={autoComplete} required />
        <button type="button" className="btn sm" onClick={() => setShow(!show)} aria-pressed={show}>{show ? "Hide" : "Show"}</button>
      </div>
    </Field>
  );
}

export function AuthScreen({ onSession, onApiKey, go }) {
  const [mode, setMode] = useState("signin"); // signin | signup | forgot
  const [f, setF] = useState({ email: "", password: "", firstName: "", lastName: "" });
  const [state, setState] = useState({ busy: false, error: null, notice: null });
  const [dev, setDev] = useState(false); const [key, setKey] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const fail = (e) => setState({ busy: false, error: errText(e), notice: null });

  async function signin(e) {
    e && e.preventDefault(); setState({ busy: true, error: null, notice: null });
    try { const r = await pub.login({ email: f.email, password: f.password }); onSession(r.token, r.principal); }
    catch (ex) { fail(ex); }
  }
  async function signup(e) {
    e.preventDefault(); setState({ busy: true, error: null, notice: null });
    try {
      await pub.signup({ email: f.email, password: f.password, firstName: f.firstName, lastName: f.lastName });
      try { const r = await pub.login({ email: f.email, password: f.password }); onSession(r.token, r.principal, { justSignedUp: true }); }
      catch (_) { setState({ busy: false, error: null, notice: "If this email is new, we have sent a confirmation link. If you already have an account, sign in instead." }); setMode("signin"); }
    } catch (ex) { fail(ex); }
  }
  async function forgot(e) {
    e.preventDefault(); setState({ busy: true, error: null, notice: null });
    try { await pub.requestReset(f.email); setState({ busy: false, error: null, notice: "If that email has an account, a reset link is on its way. It works once and expires in an hour." }); }
    catch (ex) { fail(ex); }
  }
  async function useKey(e) {
    e.preventDefault(); setState({ busy: true, error: null, notice: null });
    try { await createApi({ apiKey: key.trim() }).ping(); onApiKey(key.trim()); }
    catch (ex) { fail(ex.status === 401 ? new Error("That API key was not accepted.") : ex); }
  }
  const tab = (m, label) => <button type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setState({ busy: false, error: null, notice: null }); }}>{label}</button>;

  return (
    <Shell>
      {mode !== "forgot" && <div className="tabs" role="tablist" aria-label="Account">{tab("signin", "Sign in")}{tab("signup", "Create account")}</div>}
      {state.error && <Banner>{state.error}</Banner>}
      {state.notice && <Banner tone="info">{state.notice}</Banner>}

      {mode === "signin" && (
        <form className="stack" onSubmit={signin}>
          <h1>Welcome back</h1>
          <Field label="Email" id="si-e"><input id="si-e" className="input" type="email" autoComplete="username" value={f.email} onChange={set("email")} required /></Field>
          <PasswordInput id="si-p" value={f.password} onChange={set("password")} autoComplete="current-password" />
          <button className="btn primary block" disabled={state.busy}>{state.busy ? "Signing in…" : "Sign in"}</button>
          <button type="button" className="btn ghost" onClick={() => { setMode("forgot"); setState({ busy: false, error: null, notice: null }); }}>Forgot your password?</button>
        </form>
      )}
      {mode === "signup" && (
        <form className="stack" onSubmit={signup}>
          <h1>Plan trips with an AI travel agent</h1>
          <p className="sub" style={{ margin: 0 }}>Search flights and hotels, keep everything for a trip in one place, and approve each booking yourself.</p>
          <div className="grid2 tight">
            <Field label="First name" id="su-f"><input id="su-f" className="input" autoComplete="given-name" value={f.firstName} onChange={set("firstName")} required /></Field>
            <Field label="Last name" id="su-l"><input id="su-l" className="input" autoComplete="family-name" value={f.lastName} onChange={set("lastName")} required /></Field>
          </div>
          <Field label="Email" id="su-e"><input id="su-e" className="input" type="email" autoComplete="username" value={f.email} onChange={set("email")} required /></Field>
          <PasswordInput id="su-p" value={f.password} onChange={set("password")} autoComplete="new-password" />
          <p className="sub" style={{ margin: 0 }}>At least 10 characters. A few unrelated words works well.</p>
          <button className="btn primary block" disabled={state.busy}>{state.busy ? "Creating account…" : "Create account"}</button>
        </form>
      )}
      {mode === "forgot" && (
        <form className="stack" onSubmit={forgot}>
          <h1>Reset your password</h1>
          <Field label="Email" id="fp-e"><input id="fp-e" className="input" type="email" value={f.email} onChange={set("email")} required autoFocus /></Field>
          <button className="btn primary block" disabled={state.busy}>{state.busy ? "Sending…" : "Send reset link"}</button>
          <button type="button" className="btn ghost" onClick={() => { setMode("signin"); setState({ busy: false, error: null, notice: null }); }}>Back to sign in</button>
        </form>
      )}

      <details className="dev" open={dev} onToggle={(e) => setDev(e.currentTarget.open)}>
        <summary>Developer access with an agency API key</summary>
        <form className="stack" onSubmit={useKey} style={{ marginTop: 10 }}>
          <Field label="Agency API key" id="dev-k"><input id="dev-k" className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
          <button className="btn block" disabled={state.busy || !key.trim()}>Use API key</button>
        </form>
      </details>
    </Shell>
  );
}

// #/verify?token=...  (opened from the email link; works signed in or out)
export function VerifyEmailPage({ token, go, onVerified }) {
  const [st, setSt] = useState({ phase: "working", error: null }); const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; ran.current = true;
    if (!token) return setSt({ phase: "error", error: "This link is incomplete. Open the link from your email again." });
    pub.verifyEmail(token).then(() => { setSt({ phase: "done" }); onVerified && onVerified(); }).catch((e) => setSt({ phase: "error", error: errText(e) }));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Shell>
      {st.phase === "working" && <h1 aria-busy="true">Confirming your email…</h1>}
      {st.phase === "done" && <><h1>Email confirmed</h1><Banner tone="ok">You can now approve and book trips.</Banner><button className="btn primary block" onClick={() => go("#/trips")}>Continue</button></>}
      {st.phase === "error" && <><h1>Link not usable</h1><Banner>{st.error}</Banner><p className="sub" style={{ margin: 0 }}>If you already confirmed your email, you are all set. Just continue.</p><button className="btn block" onClick={() => go("#/trips")}>Continue</button></>}
    </Shell>
  );
}

// #/reset?token=...  (password reset and staff invites both land here)
export function SetPasswordPage({ token, go }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [st, setSt] = useState({ busy: false, error: null, done: false });
  async function submit(e) {
    e.preventDefault();
    if (pw !== pw2) return setSt({ busy: false, error: "The two passwords do not match.", done: false });
    setSt({ busy: true, error: null, done: false });
    try { await pub.confirmReset(token, pw); setSt({ busy: false, error: null, done: true }); } catch (ex) { setSt({ busy: false, error: errText(ex), done: false }); }
  }
  return (
    <Shell>
      {st.done ? <><h1>Password saved</h1><Banner tone="ok">You have been signed out everywhere. Sign in with your new password.</Banner><button className="btn primary block" onClick={() => go("#/trips")}>Sign in</button></> : (
        <form className="stack" onSubmit={submit}>
          <h1>Set your password</h1>
          {!token && <Banner>This link is incomplete. Open the link from your email again.</Banner>}
          {st.error && <Banner>{st.error}</Banner>}
          <PasswordInput id="sp-1" label="New password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <PasswordInput id="sp-2" label="Repeat new password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          <p className="sub" style={{ margin: 0 }}>At least 10 characters. A few unrelated words works well.</p>
          <button className="btn primary block" disabled={st.busy || !token}>{st.busy ? "Saving…" : "Save password"}</button>
        </form>
      )}
    </Shell>
  );
}
