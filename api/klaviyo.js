// /api/usebasin/klaviyo-subscribe.js
// Next.js / Vercel serverless function

const KLAVIYO_REVISION = '2025-10-15';
const H_JSONAPI = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
};

function toBool(val) {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    const s = String(val).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'checked'].includes(s);
}

function parseBody(body) {
    if (!body) return {};
    if (typeof body === 'object') return body;
    try { return JSON.parse(body); } catch { }
    try { return Object.fromEntries(new URLSearchParams(body)); } catch { }
    return {};
}

function splitName(name) {
    if (!name) return { first_name: undefined, last_name: undefined };
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0] };
    return { first_name: parts.slice(0, -1).join(' '), last_name: parts.at(-1) };
}

/** Profile fields for Create-or-Update (NOT the subscribe call). */
function buildProfileForImport(payload, req) {
    const email = payload.email?.trim();
    const phone = payload.phone?.trim() || payload.phone_number?.trim();
    const { first_name, last_name } = splitName(payload.name);

    const location = {
        address1: payload.street1 || payload.address1,
        address2: payload.street2 || payload.address2,
        city: payload.city,
        region: payload.state || payload.region,
        zip: payload.zip || payload.postal_code || payload.postcode,
        country: payload.country,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim() || undefined,
    };
    Object.keys(location).forEach((k) => (location[k] == null || location[k] === '') && delete location[k]);

    const properties = {
        source: 'Shopify Fundraiser Request',
        form: 'fundraiser-account-request',
        fundraiser_goal: payload.goal,
        school_group_name: payload.group,
        payment_method: payload.payment_method,
        comments: payload.comments,
    };
    Object.keys(properties).forEach((k) => (properties[k] == null || properties[k] === '') && delete properties[k]);

    const attributes = { email };
    if (phone) attributes.phone_number = phone;
    if (first_name) attributes.first_name = first_name;
    if (last_name) attributes.last_name = last_name;
    if (Object.keys(location).length) attributes.location = location;
    if (Object.keys(properties).length) attributes.properties = properties;

    return attributes;
}

/** Minimal payload for Subscribe call (email consent only). */
function buildSubscribeProfile(email) {
    return {
        type: 'profile',
        attributes: {
            email,
            // Why: explicitly set consent; Klaviyo can default, but this makes intent clear.
            subscriptions: {
                email: {
                    marketing: {
                        consent: 'SUBSCRIBED',
                        consented_at: new Date().toISOString(),
                    },
                },
            },
        },
    };
}

async function klaviyoFetch(url, apiKey, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            ...H_JSONAPI,
            Authorization: `Klaviyo-API-Key ${apiKey}`,
            revision: KLAVIYO_REVISION,
        },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { }
    return { status: res.status, ok: res.ok || res.status === 202, json };
}

/** Create or update profile (to set location/properties). */
async function upsertProfile({ apiKey, attributes }) {
    const url = 'https://a.klaviyo.com/api/profile-import';
    const body = { data: { type: 'profile', attributes } };
    const res = await klaviyoFetch(url, apiKey, body);
    // Accept 200 (updated) or 201 (created)
    const ok = res.status === 200 || res.status === 201;
    return { ...res, ok };
}

/** Subscribe one profile to a list (consent + list membership). */
async function subscribeToList({ apiKey, listId, email }) {
    const url = 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs';
    const profile = buildSubscribeProfile(email);
    const body = {
        data: {
            type: 'profile-subscription-bulk-create-job',
            attributes: {
                profiles: { data: [profile] },
                // historical_import not needed for real-time form consent
            },
            relationships: {
                list: { data: { type: 'list', id: listId } },
            },
        },
    };
    const res = await klaviyoFetch(url, apiKey, body);
    // Expect 202 Accepted job
    const ok = res.status === 202;
    return { ...res, ok };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const apiKey = process.env.KLAVIYO_API_KEY;
    const list1 = process.env.KLAVIYO_LIST_1;
    const list2 = process.env.KLAVIYO_LIST_2;
    if (!apiKey || !list1 || !list2) {
        console.error('Missing env vars: KLAVIYO_API_KEY, KLAVIYO_LIST_1, KLAVIYO_LIST_2');
        return res.status(500).json({ ok: false, error: 'Server not configured' });
    }

    const payload = parseBody(req.body);
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
    console.log('[Webhook] Payload summary:', {
        event: 'usebasin.form.received',
        email: payload.email,
        marketing: payload.marketing,
        ip,
    });

    const email = payload.email?.trim();
    if (!email) {
        console.warn('[Webhook] Missing email, skipping subscribe.');
        return res.status(200).json({ ok: true, skipped: true, reason: 'missing_email' });
    }

    if (!toBool(payload.marketing)) {
        console.log('[Webhook] No marketing opt-in; not subscribing.');
        return res.status(200).json({ ok: true, skipped: true, reason: 'no_marketing_opt_in' });
    }

    // 1) Upsert the profile to set properties/location (NOT in subscribe call)
    const profileAttrs = buildProfileForImport(payload, req);
    const safeLogAttrs = {
        ...profileAttrs,
        email: '[redacted]',
        phone_number: profileAttrs.phone_number ? '[redacted]' : undefined,
    };
    console.log('[Klaviyo] Upsert profile attributes (redacted):', safeLogAttrs);

    const upsert = await upsertProfile({ apiKey, attributes: profileAttrs });
    if (!upsert.ok) {
        console.error('[Klaviyo] Upsert failed', { status: upsert.status, error: upsert.json });
        return res.status(502).json({ ok: false, step: 'upsert', status: upsert.status, error: upsert.json });
    }
    console.log('[Klaviyo] Upsert OK', { status: upsert.status });

    // 2) Subscribe to both lists (email consent + list relationship)
    const [r1, r2] = await Promise.allSettled([
        subscribeToList({ apiKey, listId: list1, email }),
        subscribeToList({ apiKey, listId: list2, email }),
    ]);

    const result = {
        list1: r1.status === 'fulfilled' ? r1.value : { ok: false, status: 0, json: { error: String(r1.reason) } },
        list2: r2.status === 'fulfilled' ? r2.value : { ok: false, status: 0, json: { error: String(r2.reason) } },
    };

    console.log('[Klaviyo] Subscribe results:', {
        list1: { ok: result.list1.ok, status: result.list1.status, body: result.list1.json },
        list2: { ok: result.list2.ok, status: result.list2.status, body: result.list2.json },
    });

    const ok = Boolean(result.list1.ok) && Boolean(result.list2.ok);
    return res.status(ok ? 200 : 207).json({ ok, result });
}

/*
Why two calls?
- Klaviyo: you cannot modify custom properties in the same request that subscribes a profile. Do a profile import (create/update) first, then subscribe. Docs + community confirm. 
Refs:
- Bulk Subscribe requires JSON:API headers and supports only consent/list context. (Accept/Content-Type = application/vnd.api+json)
*/
