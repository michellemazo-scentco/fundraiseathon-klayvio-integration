// /api/usebasin/klaviyo-subscribe.js
// Vercel Serverless / Next.js API route

const KLAVIYO_API_URL = 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs';
const KLAVIYO_REVISION = '2025-10-15'; // keep in sync with Klaviyo docs

/** Convert “marketing” checkbox values to boolean. */
function toBool(val) {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val === 1;
    const s = String(val).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'checked'].includes(s);
}

/** Minimal safe JSON parse for cases where body is a string. */
function parseBody(body) {
    if (!body) return {};
    if (typeof body === 'object') return body;
    try {
        return JSON.parse(body);
    } catch {
        try {
            // support x-www-form-urlencoded forwarded as raw text
            return Object.fromEntries(new URLSearchParams(body));
        } catch {
            return {};
        }
    }
}

/** Split a full name into first/last (very basic). */
function splitName(name) {
    if (!name || typeof name !== 'string') return { first_name: undefined, last_name: undefined };
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0], last_name: undefined };
    return { first_name: parts.slice(0, -1).join(' '), last_name: parts.slice(-1).join(' ') };
}

/** Build the profile.attributes payload for Klaviyo subscribe job. */
function buildProfileAttributes(payload, req) {
    const email = payload.email?.trim();
    const phone = payload.phone?.trim() || payload.phone_number?.trim();
    const { first_name, last_name } = splitName(payload.name);

    // location: only include keys that have values
    const location = {
        address1: payload.street1 || payload.address1,
        address2: payload.street2 || payload.address2,
        city: payload.city,
        region: payload.state || payload.region,
        zip: payload.zip || payload.postal_code || payload.postcode,
        country: payload.country, // don't guess; include only if provided
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || undefined,
    };
    Object.keys(location).forEach((k) => (location[k] === undefined || location[k] === '') && delete location[k]);

    // optional context/properties for easier segmentation/debugging
    const properties = {
        source: 'Shopify Fundraiser Request',
        form: 'fundraiser-account-request',
        fundraiser_goal: payload.goal,
        school_group_name: payload.group,
        payment_method: payload.payment_method,
        comments: payload.comments,
    };
    Object.keys(properties).forEach((k) => (properties[k] === undefined || properties[k] === '') && delete properties[k]);

    const attrs = {
        email,
        ...(phone ? { phone_number: phone } : {}),
        ...(first_name ? { first_name } : {}),
        ...(last_name ? { last_name } : {}),
        ...(Object.keys(location).length ? { location } : {}),
        ...(Object.keys(properties).length ? { properties } : {}),

        // Crucial: set consent to SUBSCRIBED so profile is actually subscribed (not “Never Subscribed”)
        // Ref: Klaviyo "Subscribe Profiles" guide examples.
        subscriptions: {
            email: {
                marketing: {
                    consent: 'SUBSCRIBED',
                },
            },
        },
    };

    return attrs;
}

/** POST a single subscribe job to a list. */
async function subscribeToList({ apiKey, listId, profileAttributes }) {
    const body = {
        data: {
            type: 'profile-subscription-bulk-create-job',
            attributes: {
                profiles: {
                    data: [
                        {
                            type: 'profile',
                            attributes: profileAttributes,
                        },
                    ],
                },
            },
            relationships: {
                list: {
                    data: { type: 'list', id: listId },
                },
            },
        },
    };

    const res = await fetch(KLAVIYO_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Klaviyo-API-Key ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            revision: KLAVIYO_REVISION, // Klaviyo API version header
        },
        body: JSON.stringify(body),
    });

    // Klaviyo returns 202 (async job). Treat 202 as success.
    const ok = res.status === 202;
    let json;
    try {
        json = await res.json();
    } catch {
        json = null;
    }

    return { ok, status: res.status, data: json };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    // Check env
    const apiKey = process.env.KLAVIYO_API_KEY;
    const list1 = process.env.KLAVIYO_LIST_1;
    const list2 = process.env.KLAVIYO_LIST_2;
    if (!apiKey || !list1 || !list2) {
        console.error('Missing env vars: KLAVIYO_API_KEY, KLAVIYO_LIST_1, KLAVIYO_LIST_2');
        return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    const payload = parseBody(req.body);
    const logBase = {
        event: 'usebasin.form.received',
        email: payload.email,
        marketing: payload.marketing,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim(),
    };
    console.log('[Webhook] Payload summary:', logBase);

    // Require email
    if (!payload.email || String(payload.email).trim() === '') {
        console.warn('[Webhook] Missing email, skipping subscribe.');
        return res.status(200).json({ ok: true, skipped: true, reason: 'missing_email' });
    }

    // Respect marketing opt-in
    const optedIn = toBool(payload.marketing);
    if (!optedIn) {
        console.log('[Webhook] User did not opt into marketing; no subscription performed.');
        return res.status(200).json({ ok: true, skipped: true, reason: 'no_marketing_opt_in' });
    }

    // Build profile
    const profileAttributes = buildProfileAttributes(payload, req);
    console.log('[Klaviyo] Profile attributes (redacted):', {
        ...profileAttributes,
        email: '[redacted]',
        phone_number: profileAttributes.phone_number ? '[redacted]' : undefined,
    });

    // Subscribe to both lists in parallel
    try {
        const [r1, r2] = await Promise.allSettled([
            subscribeToList({ apiKey, listId: list1, profileAttributes }),
            subscribeToList({ apiKey, listId: list2, profileAttributes }),
        ]);

        const result = {
            list1: r1.status === 'fulfilled' ? r1.value : { ok: false, error: r1.reason?.message || 'unknown' },
            list2: r2.status === 'fulfilled' ? r2.value : { ok: false, error: r2.reason?.message || 'unknown' },
        };

        console.log('[Klaviyo] Subscribe results:', {
            list1: { ok: result.list1.ok, status: result.list1.status },
            list2: { ok: result.list2.ok, status: result.list2.status },
        });

        const ok = Boolean(result.list1.ok) && Boolean(result.list2.ok);
        return res.status(ok ? 200 : 207).json({ ok, result });
    } catch (err) {
        console.error('[Klaviyo] Subscribe error:', err);
        return res.status(500).json({ ok: false, error: 'subscribe_failed' });
    }
}

/*
Docs notes:
- Endpoint: POST /api/profile-subscription-bulk-create-jobs with a list relationship; 202 Accepted on success.
- Include subscriptions.email.marketing.consent="SUBSCRIBED" to actually subscribe the profile.
- Use header "revision: 2025-10-15".
Refs: Klaviyo "Collect email and SMS consent via API" (Subscribe Profiles + payload structure).
*/
