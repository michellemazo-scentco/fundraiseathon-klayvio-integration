// File: /api/basin-to-klaviyo.js
// Runtime: Node.js 18+ (Vercel Serverless Function)
//
// ENV VARS (set in Vercel Project Settings):
// - KLAVIYO_PRIVATE_KEY        (required)  e.g. pk_********
// - KLAVIYO_LIST_A_ID          (required)  e.g. Y6nRLr
// - KLAVIYO_LIST_B_ID          (required)  e.g. X1y2Z3
// - WEBHOOK_AUTH_BEARER        (optional)  shared secret; Basin can send "Authorization: Bearer <token>"
// - DEFAULT_COUNTRY_CODE       (optional)  e.g. "US" (fallback if form lacks country)
//
// Purpose:
// 1) Upsert a Klaviyo profile (store name/location/phone) to avoid "Never Subscribed" edge-cases.
// 2) Explicitly subscribe to two lists with marketing consent for email (always) and SMS (only with valid E.164 phone).
//
// Logging:
// - Structured JSON logs to Vercel via console.* with a per-request ID, minimal PII (redacted email/phone).
// - Each major step logs start/success/failure + duration for faster debugging.

export default async function handler(req, res) {
    const reqId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).toLowerCase();
    const startedAt = Date.now();

    // Correlate server logs with client responses
    res.setHeader("X-Request-ID", reqId);

    logInfo(reqId, "request_received", {
        method: req.method,
        contentType: (req.headers["content-type"] || "").toLowerCase(),
        userAgent: req.headers["user-agent"] || "",
    });

    try {
        if (req.method !== "POST") {
            logWarn(reqId, "method_not_allowed", { method: req.method });
            res.setHeader("Allow", "POST");
            return res.status(405).json({ error: "Method Not Allowed", reqId });
        }

        // ---- Optional bearer verification (why: prevent spoofed webhooks) ----
        const requiredBearer = process.env.WEBHOOK_AUTH_BEARER;
        const gotAuth = req.headers.authorization || "";
        if (requiredBearer) {
            const expected = `Bearer ${requiredBearer}`;
            if (gotAuth !== expected) {
                logWarn(reqId, "auth_failed", { hasAuthHeader: Boolean(gotAuth) });
                return res.status(401).json({ error: "Unauthorized", reqId });
            }
            logInfo(reqId, "auth_ok");
        }

        // ---- Parse body for JSON or x-www-form-urlencoded (why: Basin can post either) ----
        const contentType = (req.headers["content-type"] || "").toLowerCase();
        let payload = {};
        if (contentType.includes("application/json")) {
            payload = req.body || {};
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
            const raw = await readRawBody(req);
            payload = Object.fromEntries(new URLSearchParams(raw));
        } else {
            payload = typeof req.body === "object" ? req.body : {};
        }

        // ---- Normalize incoming fields ----
        const email = str(payload.email);
        if (!email) {
            logWarn(reqId, "missing_email");
            return res.status(400).json({ error: "Missing email", reqId });
        }

        const name = str(payload.name);
        const { first_name, last_name } = splitName(name);

        const rawPhone = str(payload.phone);
        const phone = isE164Phone(rawPhone) ? rawPhone : ""; // why: Klaviyo rejects invalid phones in subscription jobs

        const city = str(payload.city);
        const region = str(payload.state);
        let country = str(payload.country);
        if (!country) {
            const defaultCountry = str(process.env.DEFAULT_COUNTRY_CODE);
            if (region && isLikelyUSState(region)) country = defaultCountry || "US";
            else if (defaultCountry) country = defaultCountry;
        }

        const marketingOptIn = isChecked(payload.marketing);
        if (!marketingOptIn) {
            logInfo(reqId, "consent_not_opted_in", {
                email: redactEmail(email),
                phone: redactPhone(phone),
            });
            return res.status(200).json({
                status: "skipped",
                reason: "marketing not opted in",
                reqId,
            });
        }

        // Optional extra properties
        const profileProperties = pruneUndefined({
            signup_source: "Shopify Fundraiser Form",
            goal: str(payload.goal),
            group: str(payload.group),
            payment_method: str(payload.payment_method),
            zip: str(payload.zip),
        });

        logInfo(reqId, "normalized_payload", {
            email: redactEmail(email),
            phone: redactPhone(phone),
            city,
            region,
            country,
            hasProps: Boolean(Object.keys(profileProperties).length),
        });

        // ---- Step 1: Upsert profile ----
        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(profileProperties).length
                ? profileProperties
                : undefined,
        });

        logInfo(reqId, "profiles_upsert_start");
        await klaviyoRequest("/api/profiles", "POST", {
            data: { type: "profile", attributes: profileAttributes },
        });
        logInfo(reqId, "profiles_upsert_ok");

        // ---- Step 2: Subscribe to two lists with consent ----
        const listA = str(process.env.KLAVIYO_LIST_1);
        const listB = str(process.env.KLAVIYO_LIST_2);
        if (!listA || !listB) {
            logError(reqId, "missing_list_env", {
                KLAVIYO_LIST_1: Boolean(listA),
                KLAVIYO_LIST_2: Boolean(listB),
            });
            return res
                .status(500)
                .json({ error: "Missing KLAVIYO_LIST_A_ID or KLAVIYO_LIST_B_ID", reqId });
        }

        const includeSms = Boolean(phone);
        const subscribeBody = (listId) => ({
            data: {
                type: "profile-subscription-bulk-create-job",
                attributes: {
                    profiles: {
                        data: [
                            {
                                type: "profile",
                                attributes: pruneUndefined({
                                    email,
                                    phone_number: phone || undefined,
                                    // why: Keep minimal to reduce validation problems; Klaviyo timestamps consent.
                                    subscriptions: {
                                        email: { marketing: { consent: "SUBSCRIBED" } },
                                        ...(includeSms
                                            ? { sms: { marketing: { consent: "SUBSCRIBED" } } }
                                            : {}),
                                    },
                                }),
                            },
                        ],
                    },
                },
                relationships: { list: { data: { type: "list", id: listId } } },
            },
        });

        logInfo(reqId, "subscribe_start", {
            listA,
            listB,
            includeSms,
            email: redactEmail(email),
            phone: redactPhone(phone),
        });

        // Create the two jobs in parallel; either error will bubble to catch.
        const [aResp, bResp] = await Promise.all([
            klaviyoRequest(
                "/api/profile-subscription-bulk-create-jobs",
                "POST",
                subscribeBody(listA)
            ),
            klaviyoRequest(
                "/api/profile-subscription-bulk-create-jobs",
                "POST",
                subscribeBody(listB)
            ),
        ]);

        const jobA = aResp?.data?.id || null;
        const jobB = bResp?.data?.id || null;
        logInfo(reqId, "subscribe_ok", { jobA, jobB });

        const durationMs = Date.now() - startedAt;
        logInfo(reqId, "completed", { durationMs });

        return res.status(200).json({
            status: "ok",
            email,
            phone_included: includeSms,
            subscribed_lists: [listA, listB],
            klaviyo_jobs: [jobA, jobB].filter(Boolean),
            reqId,
            duration_ms: durationMs,
        });
    } catch (err) {
        // why: Log rich error details to Vercel; keep response minimal but include reqId for support.
        const durationMs = Date.now() - startedAt;
        logError(reqId, "unhandled_error", {
            message: err?.message || String(err),
            stack: err?.stack || "",
            durationMs,
        });
        return res.status(500).json({
            error: "Internal Error",
            message: err?.message || String(err),
            reqId,
        });
    }
}

/* ------------------------------ Helpers ------------------------------ */

function str(v) {
    if (v === undefined || v === null) return "";
    return String(v).trim();
}

function isChecked(v) {
    const s = str(v).toLowerCase();
    return ["on", "true", "1", "yes", "y"].includes(s);
}

function splitName(full) {
    if (!full) return { first_name: undefined, last_name: undefined };
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { first_name: parts[0], last_name: undefined };
    return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

function isLikelyUSState(v) {
    const s = str(v).toUpperCase();
    const states = new Set([
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI",
        "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
        "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR"
    ]);
    return states.has(s);
}

function pruneUndefined(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined && v !== null && v !== "") out[k] = v;
    }
    return out;
}

// Minimal E.164 validation (why: avoid Klaviyo 400s on subscription job)
function isE164Phone(v) {
    const s = str(v);
    return /^\+[1-9]\d{1,14}$/.test(s);
}

// ---- Logging helpers (why: consistent, searchable Vercel logs) ----
function logInfo(reqId, msg, meta = {}) {
    console.log(JSON.stringify({ level: "info", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
function logWarn(reqId, msg, meta = {}) {
    console.warn(JSON.stringify({ level: "warn", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
function logError(reqId, msg, meta = {}) {
    console.error(JSON.stringify({ level: "error", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
// Ensure we never leak secrets/PII accidentally
function safeMeta(meta) {
    const clone = { ...meta };
    if ("authorization" in clone) clone.authorization = "[redacted]";
    return clone;
}
function redactEmail(email) {
    const s = str(email);
    const [u, d] = s.split("@");
    if (!u || !d) return "";
    return `${u.slice(0, 1)}***@${d}`;
}
function redactPhone(phone) {
    const s = str(phone);
    if (!s) return "";
    return s.replace(/^\+?(\d{0,3})\d*(\d{2})$/, (_m, cc, tail) => `+${cc || ""}***${tail}`);
}

// ---- Klaviyo HTTP ----
async function klaviyoRequest(path, method, body) {
    const base = "https://a.klaviyo.com";
    const key = process.env.KLAVIYO_API_KEY;
    if (!key) throw new Error("Missing KLAVIYO_PRIVATE_KEY");

    const url = `${base}${path}`;
    try {
        const resp = await fetch(url, {
            method,
            headers: {
                Authorization: `Klaviyo-API-Key ${key}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                revision: "2025-10-15", // pin stable API revision
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        // Log non-2xx with body for easier troubleshooting
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`Klaviyo ${method} ${path} ${resp.status}: ${text}`);
        }

        const text = await resp.text();
        return text ? JSON.parse(text) : null;
    } catch (e) {
        // why: surface low-level network/parse errors with endpoint context
        throw new Error(`[klaviyoRequest] ${method} ${path} failed: ${e?.message || e}`);
    }
}

// ---- Raw body reader for urlencoded ----
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

