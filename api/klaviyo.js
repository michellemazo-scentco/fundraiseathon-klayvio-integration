export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { email, name, phone, marketing, city, state, geocoded_region, geocoded_city, geocoded_country, } = req.body;
        console.log("Incoming body:", req.body);

        if (!email) {
            return res.status(400).json({ error: "Missing email field" });
        }

        if (marketing && (marketing === "on" || marketing === true)) {
            const API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [
                process.env.KLAVIYO_LIST_1,
                process.env.KLAVIYO_LIST_2,
            ];

            const location = {
                city: city || geocoded_city || "",
                region: state || geocoded_region || "",
                country: geocoded_country || "United States",
            };

            // Step 1️⃣ — Create or update profile
            const profileRes = await fetch("https://a.klaviyo.com/api/profiles", {
                method: "POST",
                headers: {
                    "Authorization": `Klaviyo-API-Key ${API_KEY}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "revision": "2025-10-15",
                },


                body: JSON.stringify({
                    data: {
                        type: "profile",
                        attributes: {
                            email,
                            first_name: name || "",
                            phone_number: phone || "",
                            location,
                        },
                    },
                }),
            });

            const profileText = await profileRes.text();
            const profileData = profileText ? JSON.parse(profileText) : {};

            if (!profileRes.ok) {
                console.error("❌ Profile creation failed:", profileData);
                return res.status(profileRes.status).json({
                    error: "Failed to create profile",
                    details: profileData,
                });
            }

            const profileId = profileData.data?.id;
            console.log("✅ Profile created or updated:", profileId);

            // Step 2️⃣ — Add profile to each list
            for (const listId of LIST_IDS) {
                const addRes = await fetch(
                    `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles`,
                    {
                        method: "POST",
                        headers: {
                            "Authorization": `Klaviyo-API-Key ${API_KEY}`,
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "revision": "2025-10-15",
                        },
                        body: JSON.stringify({
                            data: [{ type: "profile", id: profileId }],
                        }),
                    }
                );

                // Handle empty 204
                if (addRes.status === 204) {
                    console.log(`📬 Added ${email} to list ${listId}`);
                    continue;
                }

                const addText = await addRes.text();
                const addData = addText ? JSON.parse(addText) : {};
                console.log(`📬 Klaviyo Response for ${listId}:`, addData);
            }

            // Step 3️⃣ — Subscribe user to email/SMS
            const subscriptionRes = await fetch(
                "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs",
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
                                // Historical import FALSE so double opt-in (if enabled) works normally
                                historical_import: false,

                                // OPTIONAL: only needed if historical_import = true
                                // consented_at: new Date().toISOString(),

                                profiles: [
                                    {
                                        email, // REQUIRED for email subscription
                                        phone_number: phone || undefined, // optional, if also subscribing to SMS
                                    }
                                ],

                                // The channels you want to subscribe them to
                                subscriptions: {
                                    email: marketing ? "subscribe" : undefined,
                                    sms: phone ? "subscribe" : undefined,
                                },

                                // You can attach a list if you want consent tied to that list
                                list_id: process.env.KLAVIYO_LIST_1,
                            },
                        },
                    }),
                }
            );

            const subText = await subscriptionRes.text();
            const subData = subText ? JSON.parse(subText) : {};

            if (!subscriptionRes.ok) {
                console.error("❌ Subscription failed:", subData);
            } else {
                console.log("✅ Subscribed to marketing:", subData);
            }

        }

        return res.status(200).json({ message: "Processed successfully" });
    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
