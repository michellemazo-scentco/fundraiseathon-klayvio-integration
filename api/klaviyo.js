export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { email, name, phone, marketing } = req.body;
        console.log("Incoming body:", req.body);

        // Validate required fields
        if (!email) return res.status(400).json({ error: "Missing email field" });

        // Only add to Klaviyo if marketing is checked
        if (marketing && (marketing === 'on' || marketing === true)) {
            const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [
                process.env.KLAVIYO_LIST_1,
                process.env.KLAVIYO_LIST_2
            ];

            for (const listId of LIST_IDS) {
                const response = await fetch(`https://a.klaviyo.com/api/v3/lists/${listId}/relationships/profiles/`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`
                    },
                    body: JSON.stringify({
                        data: [
                            {
                                type: "profile",
                                attributes: {
                                    email,
                                    first_name: name || "",
                                    phone_number: phone || ""
                                }
                            }
                        ]
                    })
                });

                const result = await response.json();
                console.log(`Klaviyo Response for ${listId}:`, result);
            }
        }

        return res.status(200).json({ message: 'Processed successfully' });
    } catch (error) {
        console.error('Server Error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

