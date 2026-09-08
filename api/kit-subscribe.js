/* ============================================
   PSAC — Kit newsletter subscription endpoint
   V4 flow:
   1. POST /v4/subscribers — create subscriber
   2. POST /v4/forms/{form_id}/subscribers — add to form,
      triggers double opt-in confirmation email
   3. POST /v4/tags/{tag_id}/subscribers/{id} x N — apply tags
      (the 3 base tags below, always applied, PLUS whatever
      role/interest tags this call's own extraTagIds carries)

   Base tags applied to every subscriber:
     interest:adventure  (22310823)
     status:pre-launch   (22310825)
     source:website      (22310831)

   PARAMETERIZED (Post-Adventure Check-in, 2026-09-08): previously every
   caller got exactly these 3 tags, no matter who they were -- see
   claude/psac-post-adventure-phase3-final-spec-2026-09-08.md, section 6.
   Callers may now pass an `extraTagIds` array of additional numeric Kit
   tag IDs, applied on top of (never instead of) the 3 base tags above.
   Airey created these role/interest tags directly in Kit's dashboard,
   2026-09-08:
     role:booker              23211380
     role:participant         23211384
     role:guardian             23211386  (covers both an attending
                                          guardian and a non-attending
                                          guardian_only signer -- the tag
                                          is about the PERSON's relationship
                                          to the booking, not whether they
                                          were on the trail)
     interest:family-adventure 23211391

   Only the two call sites this Phase 3 build actually needed pass
   extraTagIds today (waiver-signer-form.js's Confirm Details opt-in, and
   the new Closing card's guardian newsletter signup) -- adventure-form.js's
   own pre-booking waitlist call and adventure-prep-form.js (the booker,
   which has no Kit opt-in anywhere in this build) are both untouched,
   still getting just the 3 base tags, which is correct: there's no
   booking yet at waitlist time to derive a role from, and the booker
   never gets a role tag in this spec.

   API key stored in KIT_API_KEY environment variable
   (Vercel + .env.local), never exposed to the client.
   No external packages — fetch only, matching the convention
   documented in api/create-payment-intent.js.

   FIXED (build review, Aug 2026): was `export default async function
   handler(...)`, ES Module syntax, the only file in this repo written that
   way — every other api/*.js file uses `module.exports = async function
   handler(...)` (CommonJS). Vercel's build was silently compiling this one
   file from ESM to CommonJS on every deploy (logged as a warning: "Node.js
   functions are compiled from ESM to CommonJS"), harmless but a real
   inconsistency, not something to leave papered over now that it's been
   spotted. Converted to match the rest of the codebase; no logic changed.
   ============================================ */

const KIT_FORM_ID = '9777195';
const TAG_IDS = [22310823, 22310825, 22310831];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, extraTagIds } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  // Additive only, and defensively filtered to real positive integers --
  // this is the one field on this endpoint a client fully controls, so
  // it never gets to inject an arbitrary tag ID string into the Kit API
  // call below.
  const tagIds = TAG_IDS.concat(
    Array.isArray(extraTagIds) ? extraTagIds.filter((id) => Number.isInteger(id) && id > 0) : []
  );

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

    // Step 3: Apply every tag (the 3 base tags plus any extraTagIds this
    // call carried -- see tagIds above)
    await Promise.all(
      tagIds.map((tagId) =>
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
};
