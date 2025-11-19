// This file runs as a Serverless Function on Vercel.
// Basin will send a POST request here after your Shopify form is submitted.
// If the user opted into marketing, we will add them to TWO Klaviyo lists
// and tag their profile with custom properties.

export default async function handler(req, res) {
    console.log("hello");
    try {

        // -----------------------------------------------------
        // 1. Only allow POST requests. Reject everything else.
        // -----------------------------------------------------
        if (req.method !== "POST") {
            return res.status(405).json({ error: "Method not allowed" });
        }

        // -----------------------------------------------------
        // 2. Extract the data that Basin sends in the webhook.
        // Basin webhook JSON should match your Basin template:
        // { "email": "...", "marketing": "on", etc. }
        // -----------------------------------------------------
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

        // -----------------------------------------------------
        // 3. Email is REQUIRED to add someone to Klaviyo.
        // If it's missing, we cannot continue.
        // -----------------------------------------------------
        if (!email) {
            return res.status(400).json({ error: "Missing email" });
        }

        // -----------------------------------------------------
        // 4. Detect whether user opted into marketing.
        // Basin typically sends:
        // - "on" when checkbox is checked
        // - nothing when unchecked
        // We support multiple truthy values for flexibility.
        // -----------------------------------------------------
        const optedIn =
            marketing === "on" ||
            marketing === "true" ||
            marketing === true ||
            marketing === "yes";

        // -----------------------------------------------------
        // 5. If user did NOT opt in → Stop here.
        // This prevents adding them to any Klaviyo list.
        // -----------------------------------------------------
        if (!optedIn) {
            return res.status(200).json({
                message: "User did not opt in. Skipping Klaviyo."
            });
        }

        // -----------------------------------------------------
        // 6. Load Klaviyo credentials from Vercel env vars.
        // Set these in:
        // Vercel → Project → Settings → Environment Variables
        // -----------------------------------------------------
        const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
        console.log("Private key loaded in Vercel:", process.env.KLAVIYO_PRIVATE_KEY);


        // Two Klaviyo lists:
        // • LIST_1: Main marketing list
        // • LIST_2: Fundraise-a-thon specific marketing list
        const LIST_1 = process.env.KLAVIYO_LIST_ID_MAIN;
        const LIST_2 = process.env.KLAVIYO_LIST_ID_FAT;

        if (!KLAVIYO_PRIVATE_KEY || !LIST_1 || !LIST_2) {
            return res.status(500).json({
                error: "Missing Klaviyo environment variables"
            });
        }

        // -----------------------------------------------------
        // 7. Build the profile object once.
        // This will be reused to add the user to BOTH lists.
        // Custom properties act as "tags" in Klaviyo.
        // -----------------------------------------------------
        const profilePayload = {
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

                        // ------------------------------
                        // Custom Klaviyo tags ("properties")
                        // These appear in Klaviyo under Profile > Custom Properties.
                        // ------------------------------
                        fundraise_source: "Fundraise-a-thon",
                        list_assignment: "marketing + fundraiser request form",
                        timestamp_added: new Date().toISOString()
                    }
                }
            ]
        };

        // -----------------------------------------------------
        // 8. Reusable function to add user to a Klaviyo list.
        // We call this twice (for two lists).
        // -----------------------------------------------------
        async function addToList(listId) {
            const response = await fetch(
                `https://a.klaviyo.com/api/v2/list/${listId}/members`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "api-key": KLAVIYO_PRIVATE_KEY
                    },
                    body: JSON.stringify(profilePayload)
                }
            );

            // If Klaviyo returns an error (bad API key, wrong list ID, etc.)
            if (!response.ok) {
                const err = await response.text();
                console.error(`Klaviyo list ${listId} error:`, err);
                throw new Error(`Failed to add to Klaviyo list ${listId}`);
            }

            return response.json();
        }

        // -----------------------------------------------------
        // 9. Add the user to BOTH Klaviyo lists.
        // This is the new feature you wanted.
        // -----------------------------------------------------
        const result1 = await addToList(LIST_1);
        const result2 = await addToList(LIST_2);

        // -----------------------------------------------------
        // 10. Send a clear success response (visible in Vercel logs).
        // -----------------------------------------------------
        return res.status(200).json({
            message: "User successfully added to BOTH Klaviyo lists.",
            added_to_list_1: result1,
            added_to_list_2: result2
        });

    } catch (error) {
        // -----------------------------------------------------
        // 11. Catch any unexpected errors to avoid silent failures.
        // These appear in Vercel logs.
        // -----------------------------------------------------
        console.error("Handler error:", error);
        return res.status(500).json({ error: error.message });
    }
}
