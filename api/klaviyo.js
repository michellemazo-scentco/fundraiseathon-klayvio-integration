export default async function handler(req, res) {
    try {
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed" });
        }

        const {
            email,
            name,
            phone,
            marketing,
            street1,
            street2,
            city,
            state,
            zip
        } = req.body;

        // Only add to Klaviyo if "marketing" checkbox was ON
        const optedIn = marketing === "on" || marketing === true || marketing === "true";

        if (!optedIn) {
            return res.status(200).json({ message: "User did not opt in. Skipping Klaviyo." });
        }

        // ---- Klaviyo API ----
        const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_KEY;
        const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

        const klaviyoRes = await fetch(
            `https://a.klaviyo.com/api/v2/list/${KLAVIYO_LIST_ID}/members`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "api-key": KLAVIYO_API_KEY
                },
                body: JSON.stringify({
                    profiles: [
                        {
                            email,
                            properties: {
                                name,
                                phone,
                                street1,
                                street2,
                                city,
                                state,
                                zip,
                                source: "Fundraiser Request Form"
                            }
                        }
                    ]
                })
            }
        );

        const result = await klaviyoRes.json();

        return res.status(200).json({
            message: "User added to Klaviyo",
            klaviyo: result
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
