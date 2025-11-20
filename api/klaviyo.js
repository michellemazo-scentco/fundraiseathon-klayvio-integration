// File: /api/basin-to-klaviyo.js
// Runtime: Node.js 18+ (Vercel)
//
// ENV (your names):
// - KLAVIYO_API_KEY   (required)
// - KLAVIYO_LIST_1    (required)
// - KLAVIYO_LIST_2    (required)
// Optional:
// - WEBHOOK_AUTH_BEARER
// - DEFAULT_COUNTRY_CODE
//
// Notes:
// - Adds structured logs to Vercel (console.*).
// - Subscribes SEQUENTIALLY to both lists and logs both outcomes.

export default async function handler(req, res) {
    const t0 = now();
    const reqId = rid();

    try {
        if (req.method !== "POST") {
            log(reqId, "bad_method", { method: req.method });
            res.setHeader("Allow", "POST");
            return res.status(405).json({ error: "Method Not Allowed" });
        }

        // ---- Optional bearer auth ----
        const requiredBearer = env("WEBHOOK_AUTH_BEARER");
        const gotAuth = req.headers.authorization || "";
        if (requiredBearer && gotAuth !== `Bearer ${requiredBearer}`) {
            log(reqId, "unauthorized");
            return res.status(401).json({ error: "Unauthorized" });
        }

        // ---- Parse body ----
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

        // ---- Normalize fields ----
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

        const klaviyoKey =
            env("KLAVIYO_API_KEY") ||
            env("KLAVIYO_PRIVATE_KEY"); // fallback to old name if present

        const list1 = env("KLAVIYO_LIST_1") || env("KLAVIYO_LIST_A_ID");
        const list2 = env("KLAVIYO_LIST_2") || env("KLAVIYO_LIST_B_ID");

        if (!klaviyoKey || !list1 || !list2) {
            log(reqId, "missing_env", {
                hasKey: !!klaviyoKey,
                hasList1: !!list1,
                hasList2: !!list2,
            });
            return res.status(500).json({ error: "Missing KLAVIYO_API_KEY or list ids" });
        }

        // ---- Upsert profile ----
        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(props).length ? props : undefined,
        });

        log(reqId, "profiles_upsert_start", { email, city, region, country });

        await klaviyoRequest(
            "/api/profiles",
            "POST",
            {
                data: { type: "profile", attributes: profileAttributes },
            },
            klaviyoKey,
            reqId,
        );

        log(reqId, "profiles_upsert_ok", { ms: since(t0) });

        // ---- Subscribe to LIST 1 then LIST 2 (sequential for clearer logs) ----
        const subscribeRes = { list1: null, list2: null, errors: [] };

        subscribeRes.list1 = await subscribeOnce({
            email,
            listId: list1,
            klaviyoKey,
            reqId,
            label: "list1",
        });

        subscribeRes.list2 = await subscribeOnce({
            email,
            listId: list2,
            klaviyoKey,
            reqId,
            label: "list2",
        });

        const okLists = [subscribeRes.list1?.id, subscribeRes.list2?.id].filter(Boolean);
        const okCount = okLists.length;

        log(reqId, "done", {
            email,
            okCount,
            subscribedLists: [list1, list2],
            ms: since(t0),
        });

        return res.status(200).json({
            status: okCount === 2 ? "ok" : okCount === 1 ? "partial" : "failed",
            email,
            subscribed_lists: [list1, list2],
            klaviyo_jobs: okLists,
            details: subscribeRes,
        });
    } catch (err) {
        log(reqId, "fatal", { message: err?.message });
        return res.status(500).json({
            error: "Internal Error",
            message: err?.message || String(err),
            reqId,
        });
    }
}

/* ------------------------------ Subscribe helper ------------------------------ */

async function subscribeOnce({ email, listId, klaviyoKey, reqId, label }) {
    const body = {
        data: {
            type: "profile-subscription-bulk-create-job",
            attributes: {
                profiles: {
                    data: [
                        {
                            type: "profile",
                            attributes: {
                                email,
                                subscriptions: {
                                    email: {
                                        marketing: { consent: "SUBSCRIBED" },
                                    },
                                },
                            },
                        },
                    ],
                },
            },
            relationships: {
                list: { data: { type: "list", id: listId } },
            },
        },
    };

    log(reqId, "subscribe_start", { label, listId, email });

    try {
        const resp = await klaviyoRequest(
            "/api/profile-subscription-bulk-create-jobs",
            "POST",
            body,
            klaviyoKey,
            reqId,
        );

        const id = resp?.data?.id || null;
        log(reqId, "subscribe_ok", { label, listId, jobId: id });

        return { listId, id };
    } catch (e) {
        log(reqId, "subscribe_err", { label, listId, error: e?.message });
        return { listId, error: e?.message || String(e) };
    }
}

/* ------------------------------ Utilities ------------------------------ */

async function klaviyoRequest(path, method, body, key, reqId) {
    if (!key) throw new Error("Missing KLAVIYO_API_KEY");
    const base = "https://a.klaviyo.com";
    const url = `${base}${path}`;

    const headers = {
        Authorization: `Klaviyo-API-Key ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        revision: "2025-10-15", // keep consistent across calls
    };

    const t = now();
    const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await resp.text().catch(() => "");
    const ms = since(t);

    // Log every call outcome
    log(reqId, "klaviyo_call", {
        method,
        path,
        status: resp.status,
        ms,
        // Keep payload minimal in logs (avoid PII)
        payloadSize: body ? JSON.stringify(body).length : 0,
        respPreview: text.slice(0, 240),
    });

    if (!resp.ok) {
        throw new Error(`Klaviyo ${method} ${path} ${resp.status}: ${truncate(text, 500)}`);
    }

    return text ? JSON.parse(text) : null;
}

function str(v) { if (v === undefined || v === null) return ""; return String(v).trim(); }
function isChecked(v) { const s = str(v).toLowerCase(); return ["on", "true", "1", "yes", "y", "checked"].includes(s); }
function splitName(full) {
    if (!full) return { first_name: undefined, last_name: undefined };
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { first_name: parts[0], last_name: undefined };
    return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}
function isLikelyUSState(v) {
    const s = str(v).toUpperCase();
    const states = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI",
        "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR"]);
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
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (c) => (data += c));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}
function env(k) { return process.env[k] ? String(process.env[k]).trim() : ""; }
function rid() { try { return crypto.randomUUID(); } catch { return "req_" + Math.random().toString(36).slice(2, 10); } }
function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
function since(t) { return Math.round((now() - t)); }
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }

// Minimal global to satisfy randomUUID in some environments
const crypto = globalThis.crypto || (await import("node:crypto")).webcrypto;
