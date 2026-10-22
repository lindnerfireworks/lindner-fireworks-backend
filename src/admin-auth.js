"use strict";

const crypto = require("node:crypto");
const COOKIE = "__Host-lindner-admin";
const MAX_AGE = 8 * 60 * 60;
const sessions = new Map();

function keyMatches(supplied) {
  const expected = Buffer.from(process.env.ADMIN_KEY || "");
  const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sameOrigin(req) {
  try {
    const configured = new URL(process.env.PUBLIC_BASE_URL || "");
    return configured.protocol === "https:" && req.headers.origin === configured.origin;
  } catch { return false; }
}

function sessionToken(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  const values = cookies.map(part => part.trim()).filter(part => part.startsWith(COOKIE + "="));
  if (values.length !== 1) return "";
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : "";
}

function authorize(req) {
  if (!process.env.ADMIN_KEY) return { ok: false, status: 503, error: "admin_disabled" };
  const authorization = String(req.headers.authorization || "");
  if (authorization) {
    return authorization.startsWith("Bearer ") && keyMatches(authorization.slice(7))
      ? { ok: true, via: "bearer" } : { ok: false, status: 401, error: "unauthorized" };
  }
  const token = sessionToken(req);
  const session = sessions.get(token);
  if (!session || Date.now() >= session.expiresAt || !keyMatches(session.key)) {
    sessions.delete(token);
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req)) {
    return { ok: false, status: 403, error: "origin_forbidden" };
  }
  return { ok: true, via: "session" };
}

function issueSession(req, res, key) {
  if (!sameOrigin(req) || !keyMatches(key)) return false;
  for (const [token, value] of sessions) if (Date.now() >= value.expiresAt) sessions.delete(token);
  // A small, bounded store; a new login replaces the oldest if necessary.
  while (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
  sessions.delete(sessionToken(req));
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { key: process.env.ADMIN_KEY, expiresAt: Date.now() + MAX_AGE * 1000 });
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`);
  return true;
}

function logout(req, res) {
  sessions.delete(sessionToken(req));
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function safeNext(value) {
  return typeof value === "string" && /^\/api\/(?:admin\/(?:orders|stats)|abholschein\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(value)
    ? value : "/api/admin/orders";
}

function loginPage(next) {
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Verwaltung – Feuerwerk Lindner</title><style>body{margin:0;background:#141f47;color:#eef1fb;font:17px system-ui,sans-serif}main{max-width:420px;margin:10vh auto;padding:24px}h1{font-size:26px}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{font:inherit;padding:14px;margin:12px 0 24px;border-radius:8px;border:1px solid #7181a7}button{background:#eef1fb;color:#141f47;font-weight:600;cursor:pointer}p{line-height:1.5}</style><main><h1>Feuerwerk Lindner</h1><p>Zur Reservierungsverwaltung anmelden.</p><form method="post" action="/api/admin/login"><input type="hidden" name="next" value="${safeNext(next)}"><label for="key">Verwaltungsschlüssel</label><input id="key" name="key" type="password" required autocomplete="current-password" maxlength="256"><button>Anmelden</button></form><p>Die Anmeldung gilt für acht Stunden.</p></main></html>`;
}

module.exports = { authorize, sameOrigin, issueSession, logout, loginPage, safeNext };
