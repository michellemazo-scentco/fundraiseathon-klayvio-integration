// /api/klaviyo-sync.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { email, name, phone, marketing } = req.body;

        // Only proceed if marketing checkbox is selected
        if (marketing && (marketing === 'on' || marketing === true)) {
            const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
            const LIST_IDS = [
                process.env.KLAVIYO_LIST_1,
                process.env.KLAVIYO_LIST_2,
            ];

            for (const listId of LIST_IDS) {
                await fetch(`https://a.klaviyo.com/api/v2/list/${listId}/members`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
                    },
                    body: JSON.stringify({
                        profiles: [
                            {
                                email,
                                first_name: name,
                                phone_number: phone,
                            },
                        ],
                    }),
                });
            }
        }

        return res.status(200).json({ message: 'Processed successfully' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Server error' });
    }
}
