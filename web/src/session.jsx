import { createContext, useContext } from "react";

// { api, principal, signOut, refreshPrincipal }. principal is the signed-in user (or the API-key admin).
export const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

export const ROLE_LABEL = { traveller: "Traveller", agent: "Agent", admin: "Admin" };
export const isStaff = (p) => !!p && (p.role === "agent" || p.role === "admin");
export const isTraveller = (p) => !!p && p.role === "traveller";
// Session-based staff must attest a client's consent when approving; API keys and travellers do not.
export const needsConsent = (p) => !!p && p.type === "session" && isStaff(p);
export const canManageTeam = (p) => !!p && p.role === "admin";
