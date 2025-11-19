export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // ✅ Handle both raw and JSON payloads
    let body;
    try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON format" });
    }

    try {
        const { email, name, phone, street1, street2, city, state, zip, marketing } = body;
        console.log("Incoming body:", body);

        if (!email) return res.status(400).json({ error: "Missing email field" });

        if (marketing && (marketing === "on" || marketing === true)) {
            const API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [process.env.KLAVIYO_LIST_1, process.env.KLAVIYO_LIST_2];

            const location = {
                address1: street1 || "",
                address2: street2 || "",
                city: city || "",
                region: state || "",
                zip: zip || "",
                country: "US",
            };

            const subscribeRes = await fetch("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", {
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
            });

            const text = await subscribeRes.text();
            const result = text ? JSON.parse(text) : {};
            console.log("📬 Klaviyo subscription result:", result);

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
