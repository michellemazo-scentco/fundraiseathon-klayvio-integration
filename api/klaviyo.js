// File: /api/basin-to-klaviyo.js
// Runtime: Node.js 18+
//
// ENV VARS:
// - KLAVIYO_PRIVATE_KEY                 (required)  e.g. pk_********
// - KLAVIYO_LIST_A_ID                   (required)  e.g. Y6nRLr
// - KLAVIYO_LIST_B_ID                   (required)  e.g. X1y2Z3
// - WEBHOOK_AUTH_BEARER                 (optional)
// - DEFAULT_COUNTRY_CODE                (optional)  e.g. "US"
// - KLAVIYO_SMS_ALLOWED_COUNTRY_CODES   (optional)  e.g. "1,44,61" (prefixes; "+1" US/CA, "+44" UK)
//
// Notes:
// - We upsert profile (POST; on 409 PATCH). Then we subscribe to two lists.
// - SMS consent is included only if allowed; otherwise email-only.
// - If Klaviyo rejects SMS for unsupported region, we auto-retry email-only and continue.

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

        // Auth
        const requiredBearer = process.env.WEBHOOK_AUTH_BEARER;
        if (requiredBearer) {
            const gotAuth = req.headers.authorization || "";
            if (gotAuth !== `Bearer ${requiredBearer}`) {
                logWarn(reqId, "auth_failed");
                return res.status(401).json({ error: "Unauthorized", reqId });
            }
            logInfo(reqId, "auth_ok");
        }

        // Parse body
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
        const phone = isE164Phone(rawPhone) ? rawPhone : "";

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

        // Emit a snapshot at error level so it shows up even with "Errors" filter in Vercel UI
        logError(reqId, "payload_snapshot", {
            email: redactEmail(email),
            phone: redactPhone(phone),
            city, region, country,
            hasProps: Boolean(Object.keys(profileProperties).length),
        });

        // Upsert profile
        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(profileProperties).length ? profileProperties : undefined,
        });

        logInfo(reqId, "profiles_upsert_start");
        const upsertResult = await upsertProfile(reqId, profileAttributes);
        logInfo(reqId, "profiles_upsert_ok", {
            created: upsertResult.created, patched: upsertResult.patched, profileId: upsertResult.profileId || null,
        });

        // Lists
        const listA = str(process.env.KLAVIYO_LIST_A_ID);
        const listB = str(process.env.KLAVIYO_LIST_B_ID);
        if (!listA || !listB) {
            logError(reqId, "missing_list_env", { listA: Boolean(listA), listB: Boolean(listB) });
            return res.status(500).json({ error: "Missing KLAVIYO_LIST_A_ID or KLAVIYO_LIST_B_ID", reqId });
        }

        // Determine if SMS is allowed for this phone (simple country code prefixes)
        const allowedCodes = parseAllowedCountryCodes(str(process.env.KLAVIYO_SMS_ALLOWED_COUNTRY_CODES));
        const smsAllowed = phone && isSmsAllowedForPhone(phone, allowedCodes);
        logInfo(reqId, "sms_gate_decision", {
            phone_present: Boolean(phone),
            allowed_codes: allowedCodes,
            smsAllowed,
        });

        // Subscribe with safe fallback on unsupported region
        const [jobA, jobB] = await Promise.all([
            subscribeToListSafe(reqId, listA, email, phone, smsAllowed),
            subscribeToListSafe(reqId, listB, email, phone, smsAllowed),
        ]);

        const durationMs = Date.now() - startedAt;
        logInfo(reqId, "completed", { durationMs });

        return res.status(200).json({
            status: "ok",
            email,
            phone_included: Boolean(phone),
            sms_attempted: Boolean(phone) && smsAllowed,
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

/* ----------------------- Subscribe with fallback ----------------------- */

async function subscribeToListSafe(reqId, listId, email, phone, includeSms) {
    const initialBody = buildSubscribeBody(listId, email, phone, includeSms);
    try {
        logInfo(reqId, "subscribe_try", { listId, includeSms, email: redactEmail(email), phone: redactPhone(phone) });
        const resp = await klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", initialBody);
        const job = resp?.data?.id || null;
        logInfo(reqId, "subscribe_ok", { listId, job, includeSms });
        return job;
    } catch (e) {
        // If the error is unsupported SMS region or phone_number pointer, retry without SMS
        const regionError = isUnsupportedSmsRegionError(e);
        if (regionError && includeSms) {
            logWarn(reqId, "subscribe_sms_region_unsupported_retry_email_only", {
                listId,
                detail: e?.json?.errors?.[0]?.detail || e?.message,
            });
            const emailOnlyBody = buildSubscribeBody(listId, email, phone, false);
            const resp = await klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", emailOnlyBody);
            const job = resp?.data?.id || null;
            logInfo(reqId, "subscribe_ok_after_retry_email_only", { listId, job });
            return job;
        }

        // Non-retriable → bubble up
        throw e;
    }
}

function buildSubscribeBody(listId, email, phone, includeSms) {
    return {
        data: {
            type: "profile-subscription-bulk-create-job",
            attributes: {
                profiles: {
                    data: [
                        {
                            type: "profile",
                            attributes: pruneUndefined({
                                email,
                                phone_number: phone || undefined, // keeping phone on profile even if sms not consented
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
    };
}

function isUnsupportedSmsRegionError(err) {
    const detail = err?.json?.errors?.[0]?.detail || "";
    const pointer = err?.json?.errors?.[0]?.source?.pointer || "";
    // Matches Klaviyo's message for unsupported region + points at phone_number
    return (
        (typeof detail === "string" &&
            /not in a supported region/i.test(detail)) ||
        (typeof pointer === "string" &&
            /phone_number/i.test(pointer) &&
            err?.status === 400)
    );
}

/* ----------------------- Upsert (create or patch) ----------------------- */

async function upsertProfile(reqId, attributes) {
    try {
        const resp = await klaviyoRequest("/api/profiles", "POST", {
            data: { type: "profile", attributes },
        });
        return { created: true, patched: false, profileId: resp?.data?.id || null };
    } catch (e) {
        if (e instanceof KlaviyoError && e.status === 409) {
            const duplicateId = e.json?.errors?.[0]?.meta?.duplicate_profile_id || null;
            logWarn(reqId, "profiles_create_conflict_409", { duplicateId: duplicateId || null });
            await diagnoseDuplicate(reqId, attributes); // visibility into which identifier collided

            if (duplicateId) {
                await patchProfile(reqId, duplicateId, attributes);
                return { created: false, patched: true, profileId: duplicateId };
            }
            const email = str(attributes.email);
            const id = await getProfileIdByEmail(reqId, email);
            if (!id) throw new Error(`Conflict without profile id and lookup failed for ${email}`);
            await patchProfile(reqId, id, attributes);
            return { created: false, patched: true, profileId: id };
        }
        throw e;
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
    if (!email) return null;
    const filterExpr = `equals(email,"${email}")`;
    const path = `/api/profiles?filter=${encodeURIComponent(filterExpr)}&page[size]=1`;
    logInfo(reqId, "profiles_lookup_by_email_start", { email: redactEmail(email) });
    const resp = await klaviyoRequest(path, "GET");
    const id = resp?.data?.[0]?.id || null;
    logInfo(reqId, "profiles_lookup_by_email_ok", { found: Boolean(id) });
    return id;
}

// Diagnostics for 409s
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

function isE164Phone(v) {
    const s = str(v);
    return /^\+[1-9]\d{1,14}$/.test(s);
}

function parseAllowedCountryCodes(raw) {
    if (!raw) return [];
    return raw.split(",").map((x) => x.trim()).filter(Boolean);
}
function isSmsAllowedForPhone(phone, allowedCodes) {
    if (!phone || !allowedCodes.length) return false;
    // Match if phone starts with any "+<code>"
    return allowedCodes.some((code) => phone.startsWith(`+${code}`));
}

/* --------------------------- Logging utilities --------------------------- */

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
    const key = process.env.KLAVIYO_PRIVATE_KEY;
    if (!key) throw new Error("Missing KLAVIYO_PRIVATE_KEY");

    const resp = await fetch(`${base}${path}`, {
        method,
        headers: {
            Authorization: `Klaviyo-API-Key ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            revision: "2025-10-15",
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
