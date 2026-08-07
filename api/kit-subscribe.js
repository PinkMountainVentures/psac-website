/* ============================================
   PSAC — Kit newsletter subscription endpoint
   Subscribes an email to the Kit pre-launch waitlist and applies
   the three standard tags for a website signup:
     interest:adventure  (22310823)
     status:pre-launch   (22310825)
     source:website      (22310831)

   Uses Kit API v4. API key stored in KIT_API_KEY environment
   variable (Vercel + .env.local), never exposed to the client.
   No external packages — fetch only, matching the convention
   documented in api/create-payment-intent.js.
   ============================================ */

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

  const TAG_IDS = [22310823, 22310825, 22310831];

  try {
    // Create or update subscriber
    const subscribeRes = await fetch('https://api.kit.com/v4/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kit-Api-Key': apiKey,
      },
      body: JSON.stringify({
        email_address: email.trim().toLowerCase(),
      }),
    });

    const subscribeData = await subscribeRes.json();

    if (!subscribeRes.ok) {
      console.error('Kit subscribe error:', subscribeData);
      return res.status(502).json({ error: 'Could not add you to the list. Please try again.' });
    }

    const subscriberId = subscribeData.subscriber?.id;
    if (!subscriberId) {
      console.error('Kit returned no subscriber id:', subscribeData);
      return res.status(502).json({ error: 'Could not add you to the list. Please try again.' });
    }

    // Apply all three tags
    await Promise.all(
      TAG_IDS.map((tagId) =>
        fetch(`https://api.kit.com/v4/subscribers/${subscriberId}/tags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Kit-Api-Key': apiKey,
          },
          body: JSON.stringify({ tag_id: tagId }),
        })
      )
    );

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Kit subscription error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
