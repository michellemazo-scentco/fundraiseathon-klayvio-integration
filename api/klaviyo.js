export const config = {
    api: {
        bodyParser: false, // disable automatic parsing so we can handle raw JSON safely
    },
};

import { buffer } from "micro";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 🧩 Step 1 — Parse the raw body manually (since Basin sends JSON)
        const rawBody = (await buffer(req)).toString();
        const body = JSON.parse(rawBody);

        console.log("Incoming Basin payload:", body);

        const {
            email,
            name,
            phone,
            street1,
            street2,
            city,
            state,
            zip,
            marketing,
            geocoded_country,
            geocoded_region,
            geocoded_city,
        } = body;

        if (!email) {
            return res.status(400).json({ error: "Missing email field" });
        }

        // ✅ Only add if marketing consent is on
        if (marketing && (marketing === "on" || marketing === true)) {
            const API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [process.env.KLAVIYO_LIST_1, process.env.KLAVIYO_LIST_2];

            // ✅ Step 2 — Build location details
            const location = {
                city: city || geocoded_city || "",
                region: state || geocoded_region || "",
                country: geocoded_country || "US",
            };

            // ✅ Step 3 — Subscribe with full consent + location
            const subscribeRes = await fetch(
                "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Klaviyo-API-Key ${API_KEY}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "revision": "2025-10-15",
                    },
                    body: JSON.stringify({
                        data: {
                            type: "profile-subscription-bulk-create-job",
                            attributes: {
                                subscriptions: LIST_IDS.map((listId) => ({
                                    channels: ["email"],
                                    profiles: [
                                        {
                                            email,
                                            first_name: name || "",
                                            phone_number: phone || "",
                                            location,
                                        },
                                    ],
                                    list_id: listId,
                                })),
                            },
                        },
                    }),
                }
            );

            const text = await subscribeRes.text();
            const result = text ? JSON.parse(text) : {};
            console.log("Klaviyo subscription result:", result);

            if (!subscribeRes.ok) {
                return res.status(subscribeRes.status).json({
                    error: "Failed to subscribe profile",
                    details: result,
                });
            }
        }

        return res.status(200).json({ message: "Processed successfully" });
    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
