// File: /api/klaviyo.js
// Runtime: Node 18+ (Vercel, CommonJS)
// Adds optional "historical import" to bypass double opt-in for LIST_1.
// ENV:
//   KLAVIYO_API_KEY (required)
//   KLAVIYO_LIST_1, KLAVIYO_LIST_2 (required)
//   FORCE_HISTORICAL_IMPORT_LIST_1=true|false (optional; default false)
//   WEBHOOK_AUTH_BEARER, DEFAULT_COUNTRY_CODE (optional)

module.exports = async function handler(req, res) {
    const t0 = now();
    const reqId = rid();

    try {
        if (req.method !== "POST") {
            log(reqId, "bad_method", { method: req.method });
            res.setHeader("Allow", "POST");
            return res.status(405).json({ error: "Method Not Allowed" });
        }

        const requiredBearer = env("WEBHOOK_AUTH_BEARER");
        if (requiredBearer && (req.headers.authorization || "") !== `Bearer ${requiredBearer}`) {
            log(reqId, "unauthorized");
            return res.status(401).json({ error: "Unauthorized" });
        }

        // Parse
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
            log(reqId, "missing_email", { payloadKeys: Object.keys(payload) });
            return res.status(400).json({ error: "Missing email" });
        }

        const name = str(payload.name);
        const { first_name, last_name } = splitName(name);
        const phone = str(payload.phone);
        const city = str(payload.city);
        const region = str(payload.state);
        let country = str(payload.country);
        if (!country) {
            const defaultCountry = env("DEFAULT_COUNTRY_CODE");
            if (region && isLikelyUSState(region)) country = defaultCountry || "US";
            else if (defaultCountry) country = defaultCountry;
        }

        const marketingOptIn = isChecked(payload.marketing);
        if (!marketingOptIn) {
            log(reqId, "skip_no_marketing", { email });
            return res.status(200).json({ status: "skipped", reason: "marketing not opted in" });
        }

        const props = pruneUndefined({
            signup_source: "Shopify Fundraiser Form",
            goal: str(payload.goal),
            group: str(payload.group),
            payment_method: str(payload.payment_method),
            zip: str(payload.zip),
        });

        const klaviyoKey = env("KLAVIYO_API_KEY") || env("KLAVIYO_PRIVATE_KEY");
        const list1 = env("KLAVIYO_LIST_1") || env("KLAVIYO_LIST_A_ID");
        const list2 = env("KLAVIYO_LIST_2") || env("KLAVIYO_LIST_B_ID");
        if (!klaviyoKey || !list1 || !list2) {
            log(reqId, "missing_env", { hasKey: !!klaviyoKey, hasList1: !!list1, hasList2: !!list2 });
            return res.status(500).json({ error: "Missing KLAVIYO_API_KEY or list ids" });
        }

        // Upsert profile (adds location)
        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(props).length ? props : undefined,
        });

        log(reqId, "profiles_upsert_start", { email, city, region, country });
        await klaviyoRequest("/api/profiles", "POST", { data: { type: "profile", attributes: profileAttributes } }, klaviyoKey, reqId);
        log(reqId, "profiles_upsert_ok", { ms: since(t0) });

        // Detect List 1 double opt-in and optional bypass via historical import.
        const list1Meta = await safeCall(() => klaviyoRequest(`/api/lists/${list1}`, "GET", null, klaviyoKey, reqId));
        const list2Meta = await safeCall(() => klaviyoRequest(`/api/lists/${list2}`, "GET", null, klaviyoKey, reqId));
        const list1Type = list1Meta?.data?.type || "unknown";
        const list2Type = list2Meta?.data?.type || "unknown";

        // NB: public API doesn’t directly expose "double opt-in" toggle here.
        // We’ll rely on env flag to force historical import for list1 if desired.
        const forceHistList1 = /^(1|true|yes)$/i.test(env("FORCE_HISTORICAL_IMPORT_LIST_1"));

        if (list1Type !== "list") log(reqId, "list_type_warning", { label: "list1", listId: list1, type: list1Type });
        if (list2Type !== "list") log(reqId, "list_type_warning", { label: "list2", listId: list2, type: list2Type });

        // Subscribe both lists
        const outcomes = {};
        outcomes.list1 = await subscribePollVerify({
            label: "list1",
            email,
            listId: list1,
            klaviyoKey,
            reqId,
            historicalImport: forceHistList1, // toggle
        });

        outcomes.list2 = await subscribePollVerify({
            label: "list2",
            email,
            listId: list2,
            klaviyoKey,
            reqId,
            historicalImport: false,
        });

        const okCount = [outcomes.list1?.member, outcomes.list2?.member].filter(Boolean).length;

        log(reqId, "done", { email, okCount, subscribedLists: [list1, list2], ms: since(t0), list1: outcomes.list1, list2: outcomes.list2 });

        return res.status(200).json({
            status: okCount === 2 ? "ok" : okCount === 1 ? "partial" : "failed",
            email,
            results: outcomes,
            reqId,
        });
    } catch (err) {
        log(reqId, "fatal", { message: err?.message });
        return res.status(500).json({ error: "Internal Error", message: err?.message || String(err), reqId });
    }
};

/* ------------------------------ Subscribe + Poll + Verify ------------------------------ */

async function subscribePollVerify({ label, email, listId, klaviyoKey, reqId, historicalImport }) {
    const consentedAt = new Date(Date.now() - 1000).toISOString(); // must be in the past if historical_import=true

    const jobBody = {
        data: {
            type: "profile-subscription-bulk-create-job",
            attributes: {
                ...(historicalImport ? { historical_import: true } : null), // bypass double opt-in if true
                profiles: {
                    data: [
                        {
                            type: "profile",
                            attributes: {
                                email,
                                subscriptions: {
                                    email: {
                                        marketing: pruneUndefined({
                                            consent: "SUBSCRIBED",
                                            // Required when historical_import=true
                                            consented_at: historicalImport ? consentedAt : undefined,
                                        }),
                                    },
                                },
                            },
                        },
                    ],
                },
            },
            relationships: { list: { data: { type: "list", id: listId } } },
        },
    };

    log(reqId, "subscribe_start", { label, listId, email, historicalImport });

    let jobId = null;
    try {
        const resp = await klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", jobBody, klaviyoKey, reqId);
        jobId = resp?.data?.id || null;
        log(reqId, "subscribe_ok", { label, listId, jobId });
    } catch (e) {
        log(reqId, "subscribe_err", { label, listId, error: e?.message });
        return { listId, label, jobId: null, member: false, reason: e?.message || "job_creation_failed" };
    }

    const poll = await pollJob({ jobId, klaviyoKey, reqId, label, maxMs: 8000, stepMs: 800 });
    const jobStatus = poll?.data?.attributes?.status || "unknown";
    const jobErrors = poll?.data?.attributes?.errors || [];
    if (jobErrors?.length) {
        log(reqId, "subscribe_job_errors", { label, listId, firstError: stringifySafe(jobErrors[0]), total: jobErrors.length });
    }

    const member = await isMember({ listId, email, klaviyoKey, reqId });
    if (member) log(reqId, "verify_member_ok", { label, listId });
    else log(reqId, "verify_member_false", { label, listId, jobStatus, historicalImport });

    return { listId, label, jobId, jobStatus, jobErrorsCount: Array.isArray(jobErrors) ? jobErrors.length : 0, member, historicalImportUsed: !!historicalImport };
}

/* ------------------------------ Low-level helpers ------------------------------ */

async function pollJob({ jobId, klaviyoKey, reqId, label, maxMs = 8000, stepMs = 800 }) {
    const start = now();
    let last = null;
    while (since(start) < maxMs) {
        try {
            const resp = await klaviyoRequest(`/api/profile-subscription-bulk-create-jobs/${jobId}`, "GET", null, klaviyoKey, reqId);
            last = resp;
            const status = resp?.data?.attributes?.status;
            log(reqId, "subscribe_job_status", { label, jobId, status });
            if (status === "finished") return resp;
        } catch (e) {
            log(reqId, "subscribe_job_status_err", { label, jobId, error: e?.message });
        }
        await sleep(stepMs);
    }
    return last;
}

async function isMember({ listId, email, klaviyoKey, reqId }) {
    const filter = encodeURIComponent(`equals(email,"${email}")`);
    try {
        const resp = await klaviyoRequest(`/api/lists/${listId}/profiles?filter=${filter}&page[size]=1`, "GET", null, klaviyoKey, reqId);
        const count = Array.isArray(resp?.data) ? resp.data.length : 0;
        return count > 0;
    } catch (e) {
        log(reqId, "verify_member_err", { listId, error: e?.message });
        return false;
    }
}

/* ------------------------------ HTTP + utils ------------------------------ */

async function klaviyoRequest(path, method, body, key, reqId) {
    if (!key) throw new Error("Missing KLAVIYO_API_KEY");
    const base = "https://a.klaviyo.com";
    const url = `${base}${path}`;
    const headers = {
        Authorization: `Klaviyo-API-Key ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        revision: "2025-10-15",
    };
    const t = now();
    const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await resp.text().catch(() => "");
    const ms = since(t);
    log(reqId, "klaviyo_call", { method, path, status: resp.status, ms, payloadSize: body ? JSON.stringify(body).length : 0, respPreview: text.slice(0, 240) });
    if (!resp.ok) throw new Error(`Klaviyo ${method} ${path} ${resp.status}: ${truncate(text, 700)}`);
    return text ? JSON.parse(text) : null;
}

function readRawBody(req) { return new Promise((resolve, reject) => { let data = ""; req.setEncoding("utf8"); req.on("data", (c) => (data += c)); req.on("end", () => resolve(data)); req.on("error", reject); }); }
function str(v) { return v == null ? "" : String(v).trim(); }
function isChecked(v) { const s = str(v).toLowerCase(); return ["on", "true", "1", "yes", "y", "checked"].includes(s); }
function splitName(full) { if (!full) return { first_name: undefined, last_name: undefined }; const p = full.split(/\s+/).filter(Boolean); return p.length === 1 ? { first_name: p[0], last_name: undefined } : { first_name: p[0], last_name: p.slice(1).join(" ") }; }
function isLikelyUSState(v) { const s = str(v).toUpperCase(); const states = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR"]); return states.has(s); }
function pruneUndefined(obj) { if (!obj || typeof obj !== "object") return obj; const out = {}; for (const [k, v] of Object.entries(obj)) { if (v !== undefined && v !== null && v !== "") out[k] = v; } return out; }
function env(k) { return process.env[k] ? String(process.env[k]).trim() : ""; }
function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
function since(t) { return Math.round((now() - t)); }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const { randomUUID } = require("node:crypto");
function rid() { try { return randomUUID(); } catch { return "req_" + Math.random().toString(36).slice(2, 10); } }
function stringifySafe(x) { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } }
function log(reqId, event, data) { try { console.log(JSON.stringify({ reqId, event, ...data })); } catch { console.log(`[${reqId}] ${event}`); } }
