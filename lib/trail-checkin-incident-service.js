/**
 * lib/trail-checkin-incident-service.js
 *
 * Full roster return check-in + "Not everyone's back" guest experience
 * (2026-09-08). See claude/psac-trail-checkin-return-roster-and-sar-
 * experience-proposal-2026-09-08.md (the Claude Project doc, six rounds
 * of review) for the full design and reasoning. This file is the ONE
 * shared engine behind every surface that can reach it -- Surface A (the
 * booker, api/adventure-prep.js) and every Surface B variant (a plain
 * attending participant, a participant who's also a guardian, and a
 * non-attending guardian, all via api/waiver.js) -- each surface's own
 * API layer resolves its own token down to a bookingId (and, for
 * Surface B, a participantId/role) first, then calls straight into the
 * functions here. Nothing here is duplicated per surface.
 *
 * Two entry points:
 *
 * confirmTrailReturnRoster() backs the "Everyone back from [trail]?"
 * roster-confirm sheet, same visual family as the existing Heading Out
 * sheet. Unlike lib/adventure-prep-service.js's confirmHeadingOut(),
 * this is NOT strictly write-once -- a roster can go from unclean to
 * clean once a previously-missing person actually returns and the group
 * re-confirms, so every call here re-writes the snapshot rather than
 * short-circuiting on an existing value. Roster source prefers the
 * Heading Out snapshot (trail_day_roster_json) and falls back to the
 * full attending roster when that's empty (guest never tapped Heading
 * Out, or came in via the SMS STARTED path, which doesn't fill it
 * either) -- a real gap found on review, not present in the original
 * design.
 *
 * reportTrailCheckinIncident() backs the six-option "What's going on?"
 * triage (injury / lost_separated / heat_illness / running_longer /
 * overdue_unknown / other). One Open incident per booking, upserted, per
 * a one-way tier rule found on review: a submission can only RAISE the
 * incident's urgency, never lower it -- a second, less-informed report
 * (a companion who doesn't know someone already reported an injury)
 * can't silently downgrade an already-Critical incident; the new
 * information is still captured, appended to other_notes, but only a
 * staff member resolving the incident from the ops side can actually
 * close or downgrade one. Also drives the running-longer backstop: a
 * SECOND consecutive running_longer report on the same booking (not the
 * first, that's the ordinary case this branch exists for) fires an
 * outbound SMS to the group and bumps the incident straight to
 * Critical, explicitly asking staff to place the actual phone call per
 * the Protocol's own Section 3 "attempt contact" step -- phone calls
 * themselves stay a human, staff-side action, this never auto-dials
 * anyone.
 *
 * Never read by any guest-facing code path. adventure-prep-form.js and
 * waiver-signer-form.js write to this table and never read it back, so
 * nothing reported here (a personal description, a medical note, a
 * revised finish time) can ever surface to any guest, including a
 * non-attending guardian who might otherwise have hub access to the
 * same booking. Staff-only, read from the ops side.
 */

'use strict';

const { sql } = require('./db');
const { genId } = require('./ids');
const { sendSms } = require('./send-sms');
const { getSiteUrl } = require('./site-url');

const CRITICAL_CATEGORIES = ['injury', 'lost_separated', 'heat_illness'];
const TIER_RANK = { urgent: 1, critical: 2 };

function tierForCategory(category, revisionCount) {
  if (CRITICAL_CATEGORIES.indexOf(category) !== -1) return 'critical';
  // Running-longer backstop: a second (or later) consecutive report is
  // no longer the ordinary "revised our estimate once" case -- Airey's
  // direct call that this should carry real weight, not just quieter
  // ops visibility.
  if (category === 'running_longer' && (revisionCount || 0) >= 2) return 'critical';
  return 'urgent';
}

function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

function categoryLabel(category) {
  return {
    injury: 'Injury reported',
    lost_separated: 'Lost/separated reported',
    heat_illness: 'Heat illness reported',
    running_longer: 'Running longer than expected',
    overdue_unknown: 'Not back, reason unknown',
    other: 'Other issue reported',
  }[category] || category;
}

/**
 * Heading Out's own snapshot first; falls back to the full attending
 * roster if that snapshot is empty/missing. Found on review (v7): the
 * original design had no answer for a guest who never tapped Heading
 * Out, or came in via the SMS STARTED path, which doesn't fill
 * trail_day_roster_json either.
 */
async function getReturnRosterSource(bookingId) {
  const apRows = await sql`SELECT trail_day_roster_json FROM adventure_prep WHERE booking_id = ${bookingId}`;
  const headingOutRoster = apRows[0] && apRows[0].trail_day_roster_json;
  if (Array.isArray(headingOutRoster) && headingOutRoster.length) {
    return headingOutRoster.map((r) => ({ participantId: r.participantId, name: r.name }));
  }
  const rows = await sql`
    SELECT participant_id, display_name FROM booking_participants
    WHERE experience_booking_id = ${bookingId} AND is_participating = true
    ORDER BY roster_index
  `;
  return rows.map((r) => ({ participantId: r.participant_id, name: r.display_name }));
}

/**
 * @param {string} bookingId
 * @param {{presentParticipantIds?: string[], reportedByParticipantId?: string, reportedByRole?: string}} opts
 * @returns {Promise<{ok: boolean, bookingId: string, roster: Array, clean: boolean}>}
 */
async function confirmTrailReturnRoster(bookingId, opts) {
  opts = opts || {};
  const rosterSource = await getReturnRosterSource(bookingId);
  const presentSet = new Set((opts.presentParticipantIds || []).map(String));
  const rosterSnapshot = rosterSource.map((p) => ({
    participantId: p.participantId,
    name: p.name,
    present: presentSet.has(String(p.participantId)),
  }));
  const clean = rosterSnapshot.length > 0 && rosterSnapshot.every((r) => r.present);

  const rows = await sql`
    UPDATE adventure_prep
    SET trail_checkin_at = COALESCE(trail_checkin_at, NOW()),
        trail_return_roster_json = ${JSON.stringify(rosterSnapshot)}
    WHERE booking_id = ${bookingId}
    RETURNING trail_checkin_at
  `;
  if (!rows.length) return { ok: false, error: 'Invalid booking' };

  return {
    ok: true,
    bookingId,
    trailCheckinAt: new Date(rows[0].trail_checkin_at).toISOString(),
    roster: rosterSnapshot,
    clean,
  };
}

async function findOpenIncident(bookingId) {
  const rows = await sql`
    SELECT * FROM trail_checkin_incidents
    WHERE booking_id = ${bookingId} AND status = 'Open'
    ORDER BY reported_at DESC LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Every attending participant/guardian with real SMS consent on file,
 * plus the booker -- built for the running-longer backstop specifically,
 * since no shared "cadence audience" helper exists yet in this codebase
 * (the T-3/T-1/T-0 SMS cadence itself is still a proposal, not built).
 * Consent-gated exactly like every other sendSms call in this repo,
 * never sent unconditionally.
 */
async function resolveCheckinSmsRecipients(bookingId) {
  const recipients = [];
  const bookingRows = await sql`SELECT contact_phone, sms_consent FROM experience_bookings WHERE booking_id = ${bookingId}`;
  const booking = bookingRows[0];
  if (booking && booking.sms_consent && booking.contact_phone) {
    recipients.push(booking.contact_phone);
  }
  const signerRows = await sql`
    SELECT DISTINCT ON (bp.participant_id) ws.signer_phone AS phone, ws.sms_consent AS consent
    FROM booking_participants bp
    JOIN waiver_signatures ws ON ws.participant_id = bp.participant_id
    WHERE bp.experience_booking_id = ${bookingId} AND bp.is_participating = true
    ORDER BY bp.participant_id, ws.created_at DESC
  `;
  for (const row of signerRows) {
    if (row.consent && row.phone) recipients.push(row.phone);
  }
  return Array.from(new Set(recipients));
}

/**
 * Fires on the SECOND consecutive running_longer report on a booking.
 * Reuses lib/send-sms.js directly -- the same outbound path already
 * sending the (currently only) booking-confirmation text -- no new
 * integration. Phone calls stay a human, staff-side action; the ops
 * alert this pairs with (see reportTrailCheckinIncident) says so
 * explicitly. A send failure here is logged by sendSms itself and never
 * thrown, same posture as every other outbound send in this codebase.
 */
async function fireRunningLongerBackstop(bookingId) {
  const rows = await sql`
    SELECT eb.adventure_prep_token, t.trail_name
    FROM experience_bookings eb
    LEFT JOIN adventure_prep ap ON ap.booking_id = eb.booking_id
    LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
    WHERE eb.booking_id = ${bookingId}
  `;
  const row = rows[0] || {};
  const trailName = row.trail_name || 'your trail';
  const link = row.adventure_prep_token
    ? getSiteUrl() + '/complete-adventure-prep?token=' + encodeURIComponent(row.adventure_prep_token)
    : '';
  const body = 'Palm Springs Adventure Club: following up on ' + trailName +
    ', looks like your group\'s plans have shifted more than once today. Everything okay?' +
    (link ? ' Check in here: ' + link : '') + ' Reply STOP to opt out.';

  const recipients = await resolveCheckinSmsRecipients(bookingId);
  let anySent = false;
  for (const phone of recipients) {
    const res = await sendSms({ to: phone, body });
    if (res && res.status === 'sent') anySent = true;
  }
  return anySent;
}

async function upsertOpsAlert(bookingId, category, tier, revisionCount, payload) {
  const existingAlerts = await sql`
    SELECT alert_id FROM ops_alerts
    WHERE booking_id = ${bookingId} AND alert_type = 'trail_checkin_missing' AND status = 'Open'
    ORDER BY created_at DESC LIMIT 1
  `;
  const affectedCount = Array.isArray(payload.affectedParticipantIds) ? payload.affectedParticipantIds.length : 0;
  let summary = '[TRAIL CHECK-IN] ' + categoryLabel(category);
  if (affectedCount) summary += ', ' + affectedCount + ' affected';
  if (category === 'running_longer') {
    if (revisionCount >= 2) summary += ' -- SECOND+ DELAY, call the group directly per Protocol Section 3';
    if (payload.reportedNewFinishEstimate) summary += ', revised finish ~' + payload.reportedNewFinishEstimate;
  }
  const urgencyValue = tier === 'critical' ? 'same_day_2hr' : 'urgent_same_day';

  if (existingAlerts.length) {
    await sql`
      UPDATE ops_alerts SET urgency = ${urgencyValue}, stripe_error_detail = ${summary}
      WHERE alert_id = ${existingAlerts[0].alert_id}
    `;
    return existingAlerts[0].alert_id;
  }
  const alertId = genId('ALERT');
  await sql`
    INSERT INTO ops_alerts (alert_id, booking_id, alert_type, created_at, status, urgency, stripe_error_detail)
    VALUES (${alertId}, ${bookingId}, 'trail_checkin_missing', NOW(), 'Open', ${urgencyValue}, ${summary})
  `;
  return alertId;
}

/**
 * @param {string} bookingId
 * @param {object} payload - category (required), categoryDetail,
 *   affectedParticipantIds, personalDescription, medicalNote,
 *   vehicleDescription, reportedNewFinishEstimate,
 *   reportedRemainingDistance, otherNotes, reportedByParticipantId,
 *   reportedByRole
 */
async function reportTrailCheckinIncident(bookingId, payload) {
  payload = payload || {};
  const category = payload.category;
  const validCategories = ['injury', 'lost_separated', 'heat_illness', 'running_longer', 'overdue_unknown', 'other'];
  if (validCategories.indexOf(category) === -1) return { ok: false, error: 'invalid_category' };

  const existing = await findOpenIncident(bookingId);
  const nowIso = new Date().toISOString();

  let revisionCount = 1;
  if (existing && category === 'running_longer' && existing.category === 'running_longer') {
    revisionCount = (existing.revision_count || 0) + 1;
  }

  const incomingTier = tierForCategory(category, revisionCount);
  const existingTier = existing ? tierForCategory(existing.category, existing.revision_count || 0) : null;
  const categoryWins = !existing || tierRank(incomingTier) >= tierRank(existingTier);
  const finalCategory = categoryWins ? category : existing.category;
  const finalTier = categoryWins ? incomingTier : existingTier;
  const finalRevisionCount = categoryWins ? revisionCount : (existing.revision_count || 0);

  let incidentId;
  if (!existing) {
    incidentId = genId('INC');
    await sql`
      INSERT INTO trail_checkin_incidents (
        incident_id, booking_id, category, category_detail, affected_participant_ids,
        personal_description, medical_note, vehicle_description,
        reported_new_finish_estimate, reported_remaining_distance, other_notes,
        reported_by_participant_id, reported_by_role, revision_count, status
      ) VALUES (
        ${incidentId}, ${bookingId}, ${finalCategory}, ${payload.categoryDetail || null},
        ${JSON.stringify(payload.affectedParticipantIds || [])},
        ${payload.personalDescription || null}, ${payload.medicalNote || null}, ${payload.vehicleDescription || null},
        ${payload.reportedNewFinishEstimate || null}, ${payload.reportedRemainingDistance || null},
        ${payload.otherNotes || null},
        ${payload.reportedByParticipantId || null}, ${payload.reportedByRole || null}, ${finalRevisionCount}, 'Open'
      )
    `;
  } else {
    incidentId = existing.incident_id;
    if (categoryWins) {
      const appendedNotes = payload.otherNotes
        ? (existing.other_notes ? existing.other_notes + '\n' : '') + '[' + nowIso + '] Update: ' + payload.otherNotes
        : existing.other_notes;
      await sql`
        UPDATE trail_checkin_incidents
        SET category = ${finalCategory},
            category_detail = ${payload.categoryDetail || existing.category_detail},
            affected_participant_ids = ${JSON.stringify(payload.affectedParticipantIds && payload.affectedParticipantIds.length ? payload.affectedParticipantIds : (existing.affected_participant_ids || []))},
            personal_description = ${payload.personalDescription || existing.personal_description},
            medical_note = ${payload.medicalNote || existing.medical_note},
            vehicle_description = ${payload.vehicleDescription || existing.vehicle_description},
            reported_new_finish_estimate = ${payload.reportedNewFinishEstimate || existing.reported_new_finish_estimate},
            reported_remaining_distance = ${payload.reportedRemainingDistance || existing.reported_remaining_distance},
            other_notes = ${appendedNotes},
            reported_by_participant_id = ${payload.reportedByParticipantId || existing.reported_by_participant_id},
            reported_by_role = ${payload.reportedByRole || existing.reported_by_role},
            revision_count = ${finalRevisionCount}
        WHERE incident_id = ${incidentId}
      `;
    } else {
      // Doesn't win the one-way tier rule -- still logged, never lost,
      // just doesn't get to downgrade an already-higher-tier incident.
      const note = '[' + nowIso + '] Lower-tier follow-up (' + category + '): ' +
        (payload.categoryDetail || payload.otherNotes || 'no further detail given');
      const appended = (existing.other_notes ? existing.other_notes + '\n' : '') + note;
      await sql`UPDATE trail_checkin_incidents SET other_notes = ${appended} WHERE incident_id = ${incidentId}`;
    }
  }

  await upsertOpsAlert(bookingId, finalCategory, finalTier, finalRevisionCount, payload);

  // Running-longer's revised finish time is what the guest's own Underway
  // hero card displays going forward (see adventure-prep-form.js's
  // underwayHeroHtml -- reads guestRevisedReturnAt in preference to the
  // original, conservative expected_return_at from Heading Out). Kept as
  // its own column rather than overwriting expected_return_at, which
  // stays the audit-grade Heading-Out-time baseline untouched. Only
  // written when this report actually wins the tier rule -- a lower-tier
  // running_longer follow-up that lost to an already-Critical incident
  // (categoryWins false) shouldn't silently move the displayed return
  // time either.
  let guestRevisedReturnAt = null;
  if (categoryWins && category === 'running_longer' && payload.reportedNewFinishEstimate) {
    const updated = await sql`
      UPDATE adventure_prep SET guest_revised_return_at = ${payload.reportedNewFinishEstimate}
      WHERE booking_id = ${bookingId}
      RETURNING guest_revised_return_at
    `;
    guestRevisedReturnAt = updated[0] ? new Date(updated[0].guest_revised_return_at).toISOString() : null;
  }

  let backstopFired = false;
  if (categoryWins && category === 'running_longer' && revisionCount >= 2) {
    backstopFired = await fireRunningLongerBackstop(bookingId);
  }

  return {
    ok: true,
    incidentId,
    category: finalCategory,
    tier: finalTier,
    revisionCount: finalRevisionCount,
    categoryAccepted: categoryWins,
    backstopFired,
    guestRevisedReturnAt,
  };
}


/**
 * NEW (2026-09-10, task #73 -- ops-side surfacing). Batch summary for the
 * Ops Alerts list view: category label, trail name, and affected names for
 * every booking in bookingIds that currently has an Open incident. One
 * booking can have at most one Open incident (confirmTrailReturnRoster/
 * reportTrailCheckinIncident's own upsert rule), so this is a plain lookup,
 * not an aggregate. Kept separate from getOpenIncidentDetail below --
 * the list view only needs enough to label a row, not the full staff-only
 * record (medical note, personal description, etc.), so this runs two
 * light batched queries instead of one per row.
 */
async function getOpenIncidentSummaries(bookingIds) {
  if (!bookingIds || !bookingIds.length) return {};
  const rows = await sql`
    SELECT tci.booking_id, tci.category, tci.affected_participant_ids, t.trail_name
    FROM trail_checkin_incidents tci
    LEFT JOIN adventure_prep ap ON ap.booking_id = tci.booking_id
    LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
    WHERE tci.booking_id = ANY(${bookingIds}) AND tci.status = 'Open'
  `;
  const allParticipantIds = [];
  rows.forEach((r) => {
    (Array.isArray(r.affected_participant_ids) ? r.affected_participant_ids : []).forEach((id) => allParticipantIds.push(id));
  });
  let nameById = {};
  if (allParticipantIds.length) {
    const nameRows = await sql`SELECT participant_id, display_name FROM booking_participants WHERE participant_id = ANY(${allParticipantIds})`;
    nameRows.forEach((r) => { nameById[r.participant_id] = r.display_name; });
  }
  const out = {};
  rows.forEach((r) => {
    const ids = Array.isArray(r.affected_participant_ids) ? r.affected_participant_ids : [];
    out[String(r.booking_id)] = {
      categoryLabel: categoryLabel(r.category),
      trailName: r.trail_name || '',
      affectedNames: ids.map((id) => nameById[id] || id),
    };
  });
  return out;
}

/**
 * NEW (2026-09-10, task #73). Full staff-only detail for one booking's
 * currently-Open incident -- backs the Ops Alerts Resolve panel. Joins in
 * everything a staff member needs to read before resolving: affected
 * participant names (not raw IDs), who actually reported it (resolved to a
 * name, 'booker' has no booking_participants row of its own so falls back
 * to experience_bookings.contact_name), and the trail's land-manager
 * contact when populated (same "shows nothing extra when null" posture the
 * original proposal specified -- this never asserts a contact that isn't
 * on file). Returns null when there's no Open incident for this booking
 * (e.g. it was already resolved by the time the panel is opened).
 */
async function getOpenIncidentDetail(bookingId) {
  const incident = await findOpenIncident(bookingId);
  if (!incident) return null;

  const affectedIds = Array.isArray(incident.affected_participant_ids) ? incident.affected_participant_ids : [];
  let affectedNames = [];
  if (affectedIds.length) {
    const rows = await sql`SELECT participant_id, display_name FROM booking_participants WHERE participant_id = ANY(${affectedIds})`;
    const byId = {};
    rows.forEach((r) => { byId[r.participant_id] = r.display_name; });
    affectedNames = affectedIds.map((id) => byId[id] || id);
  }

  let reportedByName = '';
  if (incident.reported_by_role === 'booker') {
    const bookingRows = await sql`SELECT contact_name FROM experience_bookings WHERE booking_id = ${bookingId}`;
    reportedByName = bookingRows[0] ? bookingRows[0].contact_name : '';
  } else if (incident.reported_by_participant_id) {
    const rows = await sql`SELECT display_name FROM booking_participants WHERE participant_id = ${incident.reported_by_participant_id}`;
    reportedByName = rows[0] ? rows[0].display_name : '';
  }

  const trailRows = await sql`
    SELECT t.trail_name, t.land_manager_name, t.land_manager_phone
    FROM adventure_prep ap
    LEFT JOIN trails t ON t.trail_id = ap.selected_trail_id
    WHERE ap.booking_id = ${bookingId}
  `;
  const trail = trailRows[0] || {};

  return {
    incidentId: incident.incident_id,
    bookingId,
    category: incident.category,
    categoryLabel: categoryLabel(incident.category),
    categoryDetail: incident.category_detail || '',
    tier: tierForCategory(incident.category, incident.revision_count || 0),
    affectedNames,
    personalDescription: incident.personal_description || '',
    medicalNote: incident.medical_note || '',
    vehicleDescription: incident.vehicle_description || '',
    reportedNewFinishEstimate: incident.reported_new_finish_estimate ? new Date(incident.reported_new_finish_estimate).toISOString() : '',
    reportedRemainingDistance: incident.reported_remaining_distance || '',
    otherNotes: incident.other_notes || '',
    reportedByRole: incident.reported_by_role || '',
    reportedByName,
    revisionCount: incident.revision_count || 0,
    reportedAt: incident.reported_at ? new Date(incident.reported_at).toISOString() : '',
    trailName: trail.trail_name || '',
    landManagerName: trail.land_manager_name || '',
    landManagerPhone: trail.land_manager_phone || '',
    status: incident.status,
  };
}

/**
 * NEW (2026-09-10, task #73). Resolves the currently-Open incident for a
 * booking AND its paired ops_alerts row in one action -- the gap found on
 * review: lib/hold-clearance-service.js's resolveAlert() only ever writes
 * ops_alerts, so without this a staff member resolving the alert left the
 * actual incident record (medical note, personal description, escalation
 * history) silently Open forever. staffNotes lands on
 * trail_checkin_incidents.staff_notes -- the column that table's own
 * migration comment already reserves as "PSAC-internal only, never read
 * by guest-facing code" -- not on ops_alerts.notes, which stays the
 * generic alert-level note field every other alert type already uses.
 */
async function resolveTrailCheckinIncident({ bookingId, resolvedBy, staffNotes }) {
  const incident = await findOpenIncident(bookingId);
  if (!incident) return { ok: false, error: 'No open incident for this booking' };

  await sql`
    UPDATE trail_checkin_incidents
    SET status = 'Resolved', resolved_at = NOW(), resolved_by = ${resolvedBy || ''}, staff_notes = ${staffNotes || null}
    WHERE incident_id = ${incident.incident_id}
  `;

  await sql`
    UPDATE ops_alerts
    SET status = 'Resolved', resolved_at = NOW(), resolved_by = ${resolvedBy || ''}, notes = ${staffNotes || ''}
    WHERE booking_id = ${bookingId} AND alert_type = 'trail_checkin_missing' AND status = 'Open'
  `;

  return { ok: true, incidentId: incident.incident_id };
}

module.exports = {
  getReturnRosterSource,
  confirmTrailReturnRoster,
  reportTrailCheckinIncident,
  categoryLabel,
  getOpenIncidentSummaries,
  getOpenIncidentDetail,
  resolveTrailCheckinIncident,
};
