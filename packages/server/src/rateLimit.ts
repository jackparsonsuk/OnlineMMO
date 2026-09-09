import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Rate limits for the HTTP endpoints.
 *
 * Using a library rather than a hand-rolled counter for the same reason the
 * password hashing is borrowed: the interesting bugs here are in the edge
 * cases — clock handling, header correctness, what counts as one client — and
 * a well-used implementation has already met them.
 *
 * These are in-memory, so they are per-process. That matches the current
 * deployment shape (one process per realm). Running several processes behind
 * one address would need a shared store; the library takes one.
 */

/** Sign-in attempts. Tight, because this is the endpoint worth guessing at. */
export function loginLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    // Only failures count. Somebody legitimately reopening the game a dozen
    // times should not be locked out of their own account.
    skipSuccessfulRequests: true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again in a few minutes." },
  });
}

/** Account creation. Slow on purpose — there is no legitimate reason to make
 *  accounts quickly, and this is what stops the table being filled. */
export function registerLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many accounts created from here. Try again later." },
  });
}

/**
 * Everything else. Loose enough that normal play never notices — the game
 * traffic is on the websocket, so these endpoints only see sign-in, the
 * character list, and the occasional health check.
 */
export function apiLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Slow down." },
    // Two exemptions. Colyseus's own matchmaking rides on this app and is game
    // traffic rather than API abuse; and a throttled health check would make an
    // orchestrator kill a container that is perfectly well.
    skip: (req) => req.path.startsWith("/matchmake") || req.path === "/health",
  });
}
