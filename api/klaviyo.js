// File: /api/basin-to-klaviyo.js
// Runtime: Node.js 18+ (Vercel Serverless Function)
//
// ENV VARS (set in Vercel Project Settings):
// - KLAVIYO_PRIVATE_KEY        (required)  e.g. pk_********
// - KLAVIYO_LIST_A_ID          (required)  e.g. Y6nRLr
// - KLAVIYO_LIST_B_ID          (required)  e.g. X1y2Z3
// - WEBHOOK_AUTH_BEARER        (optional)  shared secret; Basin can send "Authorization: Bearer <token>"
// - DEFAULT_COUNTRY_CODE       (optional)  e.g. "US" (used if your form doesn't pass a country)
//
// Why: We upsert profile first (to store location), then use Klaviyo's subscription endpoint
// for explicit marketing consent (adds to list & sets consent). This avoids "Never Subscribed".

export default async function handler(req, res) {
    try {
        if (req.method !== "POST") {
            res.setHeader("Allow", "POST");
            return res.status(405).json({ error: "Method Not Allowed" });
        }

        // ---- Optional: simple bearer verification (UseBasin can send a custom Authorization header) ----
        const requiredBearer = process.env.WEBHOOK_AUTH_BEARER;
        const gotAuth = req.headers.authorization || "";
        if (requiredBearer) {
            const expected = `Bearer ${requiredBearer}`;
            if (gotAuth !== expected) {
                return res.status(401).json({ error: "Unauthorized" });
            }
        }

        // ---- Parse body for JSON or x-www-form-urlencoded ----
        const contentType = (req.headers["content-type"] || "").toLowerCase();
        let payload = {};
        if (contentType.includes("application/json")) {
            payload = req.body || {};
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
            // Vercel doesn't parse urlencoded by default; read raw
            const raw = await readRawBody(req);
            payload = Object.fromEntries(new URLSearchParams(raw));
        } else {
            // Try best-effort JSON parse
            payload = typeof req.body === "object" ? req.body : {};
        }

        // ---- Normalize incoming fields from the Shopify form via Basin ----
        // Form fields present in the HTML snippet:
        // name, email, phone (+E.164 assembled client-side), city, state, zip, marketing (checkbox "on"/true)
        const email = str(payload.email);
        if (!email) return res.status(400).json({ error: "Missing email" });

        const name = str(payload.name);
        const { first_name, last_name } = splitName(name);

        const phone = str(payload.phone); // already E.164 per your client code
        const city = str(payload.city);
        const region = str(payload.state);
        let country = str(payload.country);
        if (!country) {
            // Heuristic: if a US state code is provided, default to US unless you pass DEFAULT_COUNTRY_CODE.
            const defaultCountry = str(process.env.DEFAULT_COUNTRY_CODE);
            if (region && isLikelyUSState(region)) country = defaultCountry || "US";
            else if (defaultCountry) country = defaultCountry;
        }

        // Marketing checkbox from your form: name="marketing"
        const marketingOptIn = isChecked(payload.marketing);
        if (!marketingOptIn) {
            // Respect consent; don't add or subscribe
            return res.status(200).json({ status: "skipped", reason: "marketing not opted in" });
        }

        // Optional custom properties you may wish to keep on the profile
        const profileProperties = pruneUndefined({
            signup_source: "Shopify Fundraiser Form",
            goal: str(payload.goal),
            group: str(payload.group),
            payment_method: str(payload.payment_method),
            zip: str(payload.zip),
        });

        // ---- Step 1: Upsert profile (store location + basic attrs) ----
        // Klaviyo Profiles API
        const profileAttributes = pruneUndefined({
            email,
            phone_number: phone,
            first_name,
            last_name,
            location: pruneUndefined({ city, region, country }),
            properties: Object.keys(profileProperties).length ? profileProperties : undefined,
        });

        await klaviyoRequest("/api/profiles", "POST", {
            data: { type: "profile", attributes: profileAttributes },
        });

        // ---- Step 2: Subscribe (consent + add to list) to two lists ----
        const listA = process.env.KLAVIYO_LIST_1;
        const listB = process.env.KLAVIYO_LIST_2;
        if (!listA || !listB) {
            return res.status(500).json({ error: "Missing KLAVIYO_LIST_A_ID or KLAVIYO_LIST_B_ID" });
        }

        const subscribeBody = (listId) => ({
            data: {
                type: "profile-subscription-bulk-create-job",
                attributes: {
                    // Include identifiers + consent. (Keep this minimal to avoid validation surprises.)
                    profiles: {
                        data: [
                            {
                                type: "profile",
                                attributes: {
                                    email,
                                    // Set email marketing consent
                                    subscriptions: {
                                        email: {
                                            marketing: {
                                                consent: "SUBSCRIBED",
                                                // consented_at optional; let Klaviyo set now unless you need to backdate
                                                // consented_at: new Date().toISOString(),
                                            },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
                relationships: {
                    list: {
                        data: { type: "list", id: listId },
                    },
                },
            },
        });

        const [aResp, bResp] = await Promise.all([
            klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", subscribeBody(listA)),
            klaviyoRequest("/api/profile-subscription-bulk-create-jobs", "POST", subscribeBody(listB)),
        ]);

        return res.status(200).json({
            status: "ok",
            email,
            subscribed_lists: [listA, listB],
            klaviyo_jobs: [aResp?.data?.id, bResp?.data?.id].filter(Boolean),
        });
    } catch (err) {
        // Only expose safe details
        return res.status(500).json({
            error: "Internal Error",
            message: err?.message || String(err),
        });
    }
}

/* ------------------------------ Helpers ------------------------------ */

function str(v) {
    if (v === undefined || v === null) return "";
    return String(v).trim();
}

function isChecked(v) {
    // Basin may send "on", "true", "1", "yes"
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

async function klaviyoRequest(path, method, body) {
    const base = "https://a.klaviyo.com";
    const key = process.env.KLAVIYO_API_KEY;
    if (!key) throw new Error("Missing KLAVIYO_PRIVATE_KEY");

    const resp = await fetch(`${base}${path}`, {
        method,
        headers: {
            "Authorization": `Klaviyo-API-Key ${key}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            // Use the latest stable revision (adjust if your account requires a fixed date)
            "revision": "2025-10-15",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        // Keep error text for troubleshooting
        throw new Error(`Klaviyo ${method} ${path} ${resp.status}: ${text}`);
    }
    // Jobs endpoints may return 204; guard parse
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}
