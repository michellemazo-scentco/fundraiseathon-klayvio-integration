import fetch from "node-fetch";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const body = req.body;

        // Log incoming data
        console.log("🟦 Incoming UseBasin Webhook:", body);

        const {
            email,
            name,
            marketing,
            city,
            state,
            country
        } = body;

        // Only proceed if user opted into marketing
        if (!marketing || marketing === "false" || marketing === "off") {
            console.log("⚪ User did not opt into marketing. Skipping Klaviyo add.");
            return res.status(200).json({ message: "No marketing consent" });
        }

        // Prepare location data
        const location = {
            city: city || null,
            region: state || null,
            country: country || null
        };

        // Build profile payload
        const profile = {
            data: {
                type: "profile",
                attributes: {
                    email,
                    first_name: name?.split(" ")[0] || "",
                    last_name: name?.split(" ")[1] || "",
                    location
                }
            }
        };

        // Function to add to a list
        async function addToKlaviyoList(listId) {
            const url = `https://a.klaviyo.com/api/v2/list/${listId}/subscribe`;
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    profiles: [
                        {
                            email,
                            first_name: profile.data.attributes.first_name,
                            last_name: profile.data.attributes.last_name,
                            location
                        }
                    ]
                })
            });

            const data = await response.json();
            console.log(`🟩 Klaviyo response for list ${listId}:`, data);
            return data;
        }

        // Subscribe to both lists
        const list1 = process.env.KLAVIYO_LIST_1;
        const list2 = process.env.KLAVIYO_LIST_2;

        const [res1, res2] = await Promise.all([
            addToKlaviyoList(list1),
            addToKlaviyoList(list2)
        ]);

        console.log("✅ Successfully added to both Klaviyo lists");

        return res.status(200).json({
            success: true,
            results: { list1: res1, list2: res2 }
        });
    } catch (err) {
        console.error("🔴 Error handling UseBasin webhook:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
