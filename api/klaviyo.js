// File: api/klaviyo-webhook.js
// Node.js Vercel Serverless Function

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const {
            email,
            name,
            city,
            state,
            country,
            marketing,
        } = req.body || {};

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
            profiles: [
                {
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
            ],
        };

        const headers = {
            Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
            "Content-Type": "application/json",
        };

        // Add to List 2 (auto-subscribe)
        const list2Response = await fetch(
            `https://a.klaviyo.com/api/v2/list/${process.env.KLAVIYO_LIST_2}/subscribe`,
            {
                method: "POST",
                headers,
                body: JSON.stringify(profilePayload),
            }
        );

        if (!list2Response.ok) {
            console.error("Error adding to List 2", await list2Response.text());
        }

        // Add to List 1 (double opt-in)
        const list1Response = await fetch(
            `https://a.klaviyo.com/api/v2/list/${process.env.KLAVIYO_LIST_1}/subscribe`,
            {
                method: "POST",
                headers,
                body: JSON.stringify(profilePayload),
            }
        );

        if (!list1Response.ok) {
            console.error("Error adding to List 1", await list1Response.text());
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
