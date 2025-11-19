// This is a Vercel Serverless Function.
// It will run automatically when Basin sends a POST request to:
// https://yourproject.vercel.app/api/klaviyo

export default async function handler(req, res) {
    try {

        // ------------------------------
        // 1. Only allow POST requests
        // ------------------------------
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed" });
        }

        // ------------------------------
        // 2. Extract data sent by Basin
        // Basin will send JSON such as:
        // {
        //   "email": "...",
        //   "name": "...",
        //   "marketing": "on",
        //   ...
        // }
        // ------------------------------
        const {
            email,
            name,
            phone,
            marketing,
            street1,
            street2,
            city,
            state,
            zip,
            goal,
            group,
            payment_method,
            comments
        } = req.body || {};

        // ------------------------------
        // 3. Email is required for Klaviyo
        // If Basin somehow didn't send an email,
        // we stop here and return an error.
        // ------------------------------
        if (!email) {
            return res.status(400).json({ error: "Missing email" });
        }

        // ------------------------------
        // 4. Determine if user opted into marketing
        // Basin normally sends:
        // - "on" for a checked checkbox
        // - nothing for unchecked
        // But we handle multiple possible values.
        // ------------------------------
        const optedIn =
            marketing === "on" ||
            marketing === "true" ||
            marketing === true ||
            marketing === "yes";

        // ------------------------------
        // 5. If they did NOT opt in, exit gracefully.
        // This prevents adding someone who didn't check the marketing box.
        // ------------------------------
        if (!optedIn) {
            return res
                .status(200)
                .json({ message: "User did not opt in. Skipping Klaviyo." });
        }

        // ------------------------------
        // 6. Get Klaviyo API credentials from Vercel environment variables
        // These are configured at:
        // Vercel → Project Settings → Environment Variables
        // ------------------------------
        const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_KEY;
        const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

        // If the keys are missing, return an error.
        if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) {
            return res.status(500).json({ error: "Klaviyo env vars not set" });
        }

        // ------------------------------
        // 7. Send the user to Klaviyo list
        // We're calling Klaviyo’s "Add to List" API endpoint:
        // POST https://a.klaviyo.com/api/v2/list/{LIST_ID}/members
        // ------------------------------
        const klaviyoResponse = await fetch(
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
                                goal,
                                group,
                                payment_method,
                                comments,

                                // Helpful metadata for you inside Klaviyo
                                source: "Fundraiser Request Form (Shopify → Basin → Vercel)"
                            }
                        }
                    ]
                })
            }
        );

        // ------------------------------
        // 8. Error handling for failed Klaviyo API requests
        // e.g., invalid key, wrong list ID, etc.
        // ------------------------------
        if (!klaviyoResponse.ok) {
            const errorText = await klaviyoResponse.text();
            console.error("Klaviyo error:", errorText);
            return res.status(500).json({
                error: "Failed to add to Klaviyo",
                detail: errorText
            });
        }

        // ------------------------------
        // 9. Parse Klaviyo server response
        // ------------------------------
        const result = await klaviyoResponse.json();

        // ------------------------------
        // 10. Return success response
        // This is mostly for debugging in the Vercel logs.
        // ------------------------------
        return res.status(200).json({
            message: "User added to Klaviyo",
            klaviyo: result
        });

    } catch (error) {
        // ------------------------------
        // 11. Catch any unexpected errors
        // ------------------------------
        console.error("Handler error:", error);
        return res.status(500).json({ error: error.message });
    }
}

