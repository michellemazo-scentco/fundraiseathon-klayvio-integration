// File: /api/basin-to-klaviyo.js
// Runtime: Node.js 18+
//
// ENV VARS:
// - KLAVIYO_PRIVATE_KEY   (required)  e.g. pk_********
// - KLAVIYO_LIST_A_ID     (required)  e.g. Y6nRLr
// - KLAVIYO_LIST_B_ID     (required)  e.g. X1y2Z3
// - WEBHOOK_AUTH_BEARER   (optional)  shared secret for Basin
// - DEFAULT_COUNTRY_CODE  (optional)  fallback country, e.g. "US"
//
// Why: Explicit "create" can 409 when profile exists. We upsert by catching 409 and PATCHing.

export default async function handler(req, res) {
    const reqId = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).toLowerCase();
    const startedAt = Date.now();
    res.setHeader("X-Request-ID", reqId);

    logInfo(reqId, "request_received", {
        method: req.method,
        contentType: (req.headers["content-type"] || "").toLowerCase(),
    });

    try {
        if (req.method !== "POST") {
            logWarn(reqId, "method_not_allowed", { method: req.method });
            res.setHeader("Allow", "POST");
            return res.status(405).json({ error: "Method Not Allowed", reqId });
        }

        // Bearer check (why: avoid spoofed webhooks)
        const requiredBearer = process.env.WEBHOOK_AUTH_BEARER;
        if (requiredBearer) {
            const gotAuth = req.headers.authorization || "";
            if (gotAuth !== `Bearer ${requiredBearer}`) {
                logWarn(reqId, "auth_failed");
                return res.status(401).json({ error: "Unauthorized", reqId });
            }
            logInfo(reqId, "auth_ok");
        }

        // Parse body (Basin may send JSON or urlencoded)
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

        // Normalize
        const email = str(payload.email);
        if (!email) {
            logWarn(reqId, "missing_email");
            return res.status(400).json({ error: "Missing email", reqId });
        }
        const name = str(payload.name);
        const { first_name, last_name } = splitName(name);

        const rawPhone = str(payload.phone);
        const phone = isE164Phone(rawPhone) ? rawPhone : ""; // why: Klaviyo rejects invalid phone

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
            logInfo(reqId, "consent_not_opted_in", { email: redactEmail(email), phone: redactPhone(phone) });
            return res.status(200).json({ status: "skipped", reason: "marketing not opted in", reqId });
        }

        const profileProperties = pruneUndefined({
            signup_source: "Shopify Fundraiser Form",
            goal: str(payload.goal),
            group: str(payload.group),
            payment_method: str(payload.payment_method),
            zip: str(payload.zip),
        });

        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(profileProperties).length ? profileProperties : undefined,
        });

        logInfo(reqId, "profiles_upsert_start", {
            email: redactEmail(email),
            phone: redactPhone(phone),
            hasProps: Boolean(Object.keys(profileProperties).length),
        });

        // Upsert (create or update on 409)
        const upsertResult = await upsertProfile(reqId, profileAttributes);

        logInfo(reqId, "profiles_upsert_ok", {
            created: upsertResult.created,
            patched: upsertResult.patched,
            profileId: upsertResult.profileId || null,
        });

        // Subscribe to two lists (email always; sms if phone present)
        const listA = str(process.env.KLAVIYO_LIST_1);
        const listB = str(process.env.KLAVIYO_LIST_2);
        if (!listA || !listB) {
            logError(reqId, "missing_list_env", { listA: Boolean(listA), listB: Boolean(listB) });
            return res.status(500).json({ error: "Missing KLAVIYO_LIST_A_ID or KLAVIYO_LIST_B_ID", reqId });
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
                                    // why: Minimal consent fields; Klaviyo timestamps internally
                                    subscriptions: {
                                        email: { marketing: { consent: "SUBSCRIBED" } },
                                        ...(includeSms ? { sms: { marketing: { consent: "SUBSCRIBED" } } } : {}),
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
            lists: [listA, listB],
            includeSms,
            email: redactEmail(email),
            phone: redactPhone(phone),
        });

        const [aResp, bResp] = await Promise.all([
            klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", subscribeBody(listA)),
            klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", subscribeBody(listB)),
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
            upsert: upsertResult,
        });
    } catch (err) {
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

/* ----------------------- Upsert helper (create or patch) ----------------------- */
// Why: POST /api/profiles 409s if the email/phone already exists. We catch 409 and PATCH that profile.

async function upsertProfile(reqId, attributes) {
    try {
        const resp = await klaviyoRequest("/api/profiles", "POST", {
            data: { type: "profile", attributes },
        });
        return { created: true, patched: false, profileId: resp?.data?.id || null };
    } catch (e) {
        if (e instanceof KlaviyoError && e.status === 409) {
            const duplicateId = e.json?.errors?.[0]?.meta?.duplicate_profile_id || null;
            logWarn(reqId, "profiles_create_conflict_409", {
                duplicateId: duplicateId || null,
                code: e.json?.errors?.[0]?.code || "duplicate_profile",
            });

            await diagnoseDuplicate(reqId, attributes);

            // If Klaviyo tells us the ID directly, PATCH it.
            if (duplicateId) {
                await patchProfile(reqId, duplicateId, attributes);
                return { created: false, patched: true, profileId: duplicateId };
            }

            // Fallback: lookup by email, then PATCH
            const email = str(attributes.email);
            const id = await getProfileIdByEmail(reqId, email);
            if (!id) throw new Error(`Conflict without profile id and lookup failed for ${email}`);
            await patchProfile(reqId, id, attributes);
            return { created: false, patched: true, profileId: id };
        }
        throw e; // not a duplicate conflict
    }

}

async function patchProfile(reqId, id, attributes) {
    logInfo(reqId, "profiles_patch_start", { id });
    await klaviyoRequest(`/api/profiles/${id}`, "PATCH", {
        data: { type: "profile", id, attributes },
    });
    logInfo(reqId, "profiles_patch_ok", { id });
}

async function getProfileIdByEmail(reqId, email) {
    // why: conflict response may omit meta.duplicate_profile_id
    if (!email) return null;
    const filterExpr = `equals(email,"${email}")`;
    const path = `/api/profiles?filter=${encodeURIComponent(filterExpr)}&page[size]=1`;
    logInfo(reqId, "profiles_lookup_by_email_start", { email: redactEmail(email) });
    const resp = await klaviyoRequest(path, "GET");
    const id = resp?.data?.[0]?.id || null;
    logInfo(reqId, "profiles_lookup_by_email_ok", { found: Boolean(id) });
    return id;
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

// E.164 sanity check (why: avoid 400s on jobs)
function isE164Phone(v) {
    const s = str(v);
    return /^\+[1-9]\d{1,14}$/.test(s);
}

// --- Add this helper anywhere below other helpers ---
async function diagnoseDuplicate(reqId, attributes) {
    const email = str(attributes.email);
    const phone = str(attributes.phone_number);
    const out = {};

    try {
        if (email) {
            const ef = `/api/profiles?filter=${encodeURIComponent(`equals(email,"${email}")`)}&page[size]=1`;
            const eres = await klaviyoRequest(ef, "GET");
            out.email_exists = Boolean(eres?.data?.length);
            out.email_profile_id = eres?.data?.[0]?.id || null;
        }
    } catch (e) {
        logWarn(reqId, "diagnose_email_lookup_failed", { message: e?.message });
    }

    try {
        if (phone) {
            const pf = `/api/profiles?filter=${encodeURIComponent(`equals(phone_number,"${phone}")`)}&page[size]=1`;
            const pres = await klaviyoRequest(pf, "GET");
            out.phone_exists = Boolean(pres?.data?.length);
            out.phone_profile_id = pres?.data?.[0]?.id || null;
        }
    } catch (e) {
        logWarn(reqId, "diagnose_phone_lookup_failed", { message: e?.message });
    }

    logInfo(reqId, "diagnose_duplicate_result", out);
    return out;
}



/* --------------------------- Logging utilities --------------------------- */
// why: Structured logs → easy search/correlation in Vercel

function logInfo(reqId, msg, meta = {}) {
    console.log(JSON.stringify({ level: "info", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
function logWarn(reqId, msg, meta = {}) {
    console.warn(JSON.stringify({ level: "warn", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
function logError(reqId, msg, meta = {}) {
    console.error(JSON.stringify({ level: "error", reqId, msg, ts: new Date().toISOString(), ...safeMeta(meta) }));
}
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

/* ------------------------------ HTTP core ------------------------------ */
// why: Throw typed errors so caller can branch on 409

class KlaviyoError extends Error {
    constructor(message, { status, json, text, method, path }) {
        super(message);
        this.name = "KlaviyoError";
        this.status = status;
        this.json = json;
        this.text = text;
        this.method = method;
        this.path = path;
    }
}

async function klaviyoRequest(path, method, body) {
    const base = "https://a.klaviyo.com";
    const key = process.env.KLAVIYO_API_KEY;
    if (!key) throw new Error("Missing KLAVIYO_PRIVATE_KEY");

    const url = `${base}${path}`;
    const resp = await fetch(url, {
        method,
        headers: {
            Authorization: `Klaviyo-API-Key ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            revision: "2025-10-15", // pinned revision
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { }
        throw new KlaviyoError(
            `Klaviyo ${method} ${path} ${resp.status}: ${text || "[no body]"}`,
            { status: resp.status, json, text, method, path }
        );
    }
    return text ? JSON.parse(text) : null;
}



/* ------------------------- Raw body for urlencoded ------------------------- */
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}
