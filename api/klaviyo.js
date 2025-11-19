export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { email, name, phone, marketing } = req.body;

        if (!email) return res.status(400).json({ error: "Missing email field" });

        if (marketing && (marketing === "on" || marketing === true)) {
            const API_KEY = process.env.KLAVIYO_API_KEY;
            const LISTS = [
                process.env.KLAVIYO_LIST_1, // must be UUIDs (v3 format)
                process.env.KLAVIYO_LIST_2,
            ];

            // 1️⃣ Create or update profile (does not collect dates)
            const profileResponse = await fetch("https://a.klaviyo.com/api/profiles", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Klaviyo-API-Key ${API_KEY}`,
                    "accept": "application/json",
                    "revision": "2024-06-15", // required by v3 API
                },
                body: JSON.stringify({
                    data: {
                        type: "profile",
                        attributes: {
                            email,
                            first_name: name || "",
                            phone_number: phone || "",
                        },
                    },
                }),
            });

            const profileData = await profileResponse.json();
            if (!profileResponse.ok) {
                console.error("Profile creation failed:", profileData);
                return res
                    .status(profileResponse.status)
                    .json({ error: "Failed to create profile", details: profileData });
            }

            const profileId = profileData.data?.id;
            console.log("✅ Profile created:", profileId);

            // 2️⃣ Subscribe to multiple lists
            for (const listId of LISTS) {
                const subResponse = await fetch(
                    `https://a.klaviyo.com/api/lists/${listId}/relationships/profiles/`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Klaviyo-API-Key ${API_KEY}`,
                            "accept": "application/json",
                            "revision": "2024-06-15",
                        },
                        body: JSON.stringify({
                            data: [{ type: "profile", id: profileId }],
                        }),
                    }
                );

                const subResult = await subResponse.json();
                console.log(`📬 Subscribed ${email} to list ${listId}:`, subResult);
            }
        }

        return res.status(200).json({ message: "Processed successfully" });
    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
