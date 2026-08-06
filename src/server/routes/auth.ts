import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

export interface AuthConfig {
  appPassword: string;
  sessionSecret: string;
  sessionTtlHours: number;
  secureCookies: boolean;
}

const COOKIE_NAME = "daybook_session";

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Equal-length digests first, so the comparison itself is constant-time. */
function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

function createSessionToken(config: AuthConfig): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + config.sessionTtlHours * 3600 }),
  ).toString("base64url");
  return `${payload}.${hmac(config.sessionSecret, payload)}`;
}

function verifySessionToken(config: AuthConfig, token: string): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!constantTimeEquals(hmac(config.sessionSecret, payload), signature)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

const loginBody = z.object({ password: z.string() });

export function loginHandler(config: AuthConfig) {
  return async (c: Context) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "expected { password }" }, 400);
    if (!constantTimeEquals(body.data.password, config.appPassword)) {
      return c.json({ error: "invalid password" }, 401);
    }
    setCookie(c, COOKIE_NAME, createSessionToken(config), {
      httpOnly: true,
      sameSite: "Strict",
      secure: config.secureCookies,
      path: "/",
      maxAge: config.sessionTtlHours * 3600,
    });
    return c.json({ ok: true });
  };
}

/** Stateless sessions: logout only clears the browser cookie — accepted
 *  consequence of the threat model, exposure bounded by the TTL. */
export function logoutHandler() {
  return (c: Context) => {
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  };
}

export function sessionGuard(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token || !verifySessionToken(config, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
