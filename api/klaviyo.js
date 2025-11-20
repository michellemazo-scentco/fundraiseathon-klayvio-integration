// File: api/klaviyo-webhook.js

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { email, name, city, state, country, marketing } = req.body || {};

        if (!email) {
            return res.status(400).json({ error: "Missing email" });
        }

        if (!marketing) {
            console.log(`User ${email} did not opt-in for marketing.`);
            return res.status(200).json({ message: "User skipped marketing opt-in" });
        }

        const [first_name, ...rest] = name ? name.split(" ") : ["", ""];
        const last_name = rest.join(" ");

        const profilePayload = {
            data: {
                type: "profile",
                attributes: {
                    email,
                    first_name,
                    last_name,
                    location: {
                        city: city || "",
                        region: state || "",
                        country: country || "",
                    },
                    properties: {
                        source: "Shopify Fundraiser Form",
                    },
                },
            },
        };

        const headers = {
            Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
            "Content-Type": "application/json",
            accept: "application/json",
            revision: "2023-02-22",
        };

        // Create or update the profile
        const profileRes = await fetch("https://a.klaviyo.com/api/profiles/", {
            method: "POST",
            headers,
            body: JSON.stringify(profilePayload),
        });

        if (!profileRes.ok) {
            const text = await profileRes.text();
            console.error("Profile creation failed:", text);
            throw new Error(text);
        }

        const profileData = await profileRes.json();
        const profileId = profileData.data.id;

        // Subscribe to List 2 (no double opt-in)
        const list2Res = await fetch(
            `https://a.klaviyo.com/api/lists/${process.env.KLAVIYO_LIST_2}/relationships/profiles/`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    data: [{ type: "profile", id: profileId }],
                }),
            }
        );

        if (!list2Res.ok) {
            console.error("Error adding to List 2", await list2Res.text());
        }

        // Subscribe to List 1 (double opt-in)
        const list1Res = await fetch(
            `https://a.klaviyo.com/api/lists/${process.env.KLAVIYO_LIST_1}/relationships/profiles/`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({
                    data: [{ type: "profile", id: profileId }],
                }),
            }
        );

        if (!list1Res.ok) {
            console.error("Error adding to List 1", await list1Res.text());
        }

        return res.status(200).json({
            message: "Successfully processed and added user to Klaviyo lists",
            email,
        });
    } catch (err) {
        console.error("Webhook error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
}
