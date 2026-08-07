/* ============================================
   PSAC — Kit newsletter subscription endpoint
   V4 flow:
   1. POST /v4/subscribers — create subscriber
   2. POST /v4/forms/{form_id}/subscribers — add to form,
      triggers double opt-in confirmation email
   3. POST /v4/tags/{tag_id}/subscribers/{id} x3 — apply tags

   Tags applied:
     interest:adventure  (22310823)
     status:pre-launch   (22310825)
     source:website      (22310831)

   API key stored in KIT_API_KEY environment variable
   (Vercel + .env.local), never exposed to the client.
   No external packages — fetch only, matching the convention
   documented in api/create-payment-intent.js.
   ============================================ */

const KIT_FORM_ID = '9777195';
const TAG_IDS = [22310823, 22310825, 22310831];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    console.error('KIT_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    // Step 1: Create subscriber
    const createRes = await fetch('https://api.kit.com/v4/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': apiKey,
      },
      body: JSON.stringify({
        email_address: cleanEmail,
      }),
    });

    const createData = await createRes.json();

    if (!createRes.ok) {
      console.error('Kit create subscriber error:', JSON.stringify(createData));
      return res.status(502).json({ error: 'Could not add you to the list. Please try again.' });
    }

    const subscriberId = createData.subscriber?.id;
    if (!subscriberId) {
      console.error('Kit returned no subscriber id:', JSON.stringify(createData));
      return res.status(502).json({ error: 'Could not add you to the list. Please try again.' });
    }

    // Step 2: Add to form by email — triggers confirmation email
    const formRes = await fetch(`https://api.kit.com/v4/forms/${KIT_FORM_ID}/subscribers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': apiKey,
      },
      body: JSON.stringify({
        email_address: cleanEmail,
      }),
    });

    if (!formRes.ok) {
      const formData = await formRes.json();
      console.error('Kit add to form error:', JSON.stringify(formData));
    }

    // Step 3: Apply all three tags
    await Promise.all(
      TAG_IDS.map((tagId) =>
        fetch(`https://api.kit.com/v4/tags/${tagId}/subscribers/${subscriberId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Kit-Api-Key': apiKey,
          },
          body: JSON.stringify({}),
        })
      )
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Kit subscription error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
