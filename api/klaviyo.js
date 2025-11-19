export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const {
            email,
            name,
            phone,
            marketing,
            city,
            state,
            geocoded_region,
            geocoded_city,
            geocoded_country,
        } = req.body;

        console.log("Incoming body:", req.body);

        if (!email) {
            return res.status(400).json({ error: "Missing email field" });
        }

        // ✅ Only proceed if user opted into marketing
        if (marketing && (marketing === "on" || marketing === true)) {
            const API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [
                process.env.KLAVIYO_LIST_1,
                process.env.KLAVIYO_LIST_2,
            ];

            // ✅ Build location object
            const location = {
                city: city || geocoded_city || "",
                region: state || geocoded_region || "",
                country: geocoded_country || "United States",
            };

            // ✅ Step 1: Create or update profile
            const profileRes = await fetch("https://a.klaviyo.com/api/profiles", {
                method: "POST",
                headers: {
                    Authorization: `Klaviyo-API-Key ${API_KEY}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    revision: "2025-10-15",
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

            // ✅ Step 2: Subscribe to lists with consent
            for (const listId of LIST_IDS) {
                const subscribeRes = await fetch(
                    "https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Klaviyo-API-Key ${API_KEY}`,
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            revision: "2025-10-15",
                        },
                        body: JSON.stringify({
                            data: {
                                type: "profile-subscription-bulk-create-job",
                                attributes: {
                                    list_id: listId,
                                    channels: phone ? ["email", "sms"] : ["email"],
                                    profiles: [
                                        {
                                            email,
                                            first_name: name || "",
                                            phone_number: phone || "",
                                            location,
                                        },
                                    ],
                                    // ⚙️ Optional: instantly subscribe (bypass double opt-in)
                                    // historical_import: true,
                                    // consented_at: new Date().toISOString(),
                                },
                            },
                        }),
                    }
                );

                const subText = await subscribeRes.text();
                const subData = subText ? JSON.parse(subText) : {};

                if (!subscribeRes.ok) {
                    console.error(`❌ Subscription failed for ${listId}:`, subData);
                    return res.status(subscribeRes.status).json({
                        error: "Failed to subscribe profile",
                        details: subData,
                    });
                }

                console.log(`📬 Subscribed ${email} to list ${listId}:`, subData);
            }
        }

        return res.status(200).json({ message: "Processed successfully" });
    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
