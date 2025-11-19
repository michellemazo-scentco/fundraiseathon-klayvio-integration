// -----------------------------------------------
// Vercel Serverless Function
// Handles Basin webhook submissions
// Subscribes opted-in users to TWO Klaviyo lists
// using the NEW Klaviyo v3 Subscription API.
//
// IMPORTANT: This requires Klaviyo private key with:
// - Profiles Read + Write
// - Lists Read + Write
// -----------------------------------------------

export default async function handler(req, res) {
    try {
        // 1. Allow only POST requests
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed" });
        }

        // 2. Extract data from Basin webhook
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

        // Must have an email to subscribe in Klaviyo
        if (!email) {
            return res.status(400).json({ error: "Missing email" });
        }

        // 3. Determine marketing opt-in status
        const optedIn =
            marketing === "on" ||
            marketing === true ||
            marketing === "true" ||
            marketing === "yes";

        // If not opted in → skip Klaviyo
        if (!optedIn) {
            return res.status(200).json({
                message: "User did not opt in. Skipping Klaviyo subscription."
            });
        }

        // 4. Load Klaviyo credentials from Vercel env vars
        const KLAVIYO_API_KEY = process.env.KLAVIYO_PRIVATE_KEY;
        const LIST_1 = process.env.KLAVIYO_LIST_ID_MAIN; // Main marketing list
        const LIST_2 = process.env.KLAVIYO_LIST_ID_FAT;  // Fundraise-a-thon list

        if (!KLAVIYO_API_KEY || !LIST_1 || !LIST_2) {
            return res.status(500).json({
                error: "Missing environment variables for Klaviyo"
            });
        }

        // 5. Build Klaviyo v3 subscription payload
        // Docs: https://developers.klaviyo.com/en/reference/create_subscriptions
        const subscribePayload = {
            data: {
                type: "subscription",
                attributes: {
                    profile: {
                        data: {
                            type: "profile",
                            attributes: {
                                email: email,
                                // Custom properties (acts as tags in Klaviyo)
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

                                    // ------------------------------
                                    // FUNDRAISE-A-THON tags
                                    // ------------------------------
                                    fundraise_source: "Fundraise-a-thon",
                                    lead_origin: "Fundraiser Request Form",
                                    timestamp_added: new Date().toISOString()
                                }
                            }
                        }
                    },
                    // Subscribe user to BOTH lists
                    list_ids: [LIST_1, LIST_2]
                }
            }
        };

        // 6. Call Klaviyo v3 API
        const response = await fetch(
            "https://a.klaviyo.com/api/profile-subscriptions/",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // NEW AUTH HEADER for v3 API
                    "Klaviyo-API-Key": KLAVIYO_API_KEY
                },
                body: JSON.stringify(subscribePayload)
            }
        );

        // 7. Klaviyo returns validation errors here
        if (!response.ok) {
            const errorText = await response.text();
            console.error("🔥 Klaviyo v3 API Error:", errorText);

            return res.status(500).json({
                error: "Klaviyo API error",
                detail: errorText
            });
        }

        // 8. Parse success response
        const result = await response.json();

        return res.status(200).json({
            message: "🎉 User subscribed through Klaviyo v3 API successfully.",
            klaviyo_result: result
        });

    } catch (error) {
        // 9. Catch unexpected failures
        console.error("🔥 Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
