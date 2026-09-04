/**
 * lib/weather-service.js
 *
 * Google Maps Platform Weather API integration (T-3+ Adventure Hub
 * refresh, weather-glance card, 2026-09-04). Populates the {tempF,
 * condition, detail} shape adventure-prep-form.js's and waiver-signer-
 * form.js's weatherCardHtml() already expect on all three hubs (Surface
 * A, Surface B attending, Surface B guardian-only) -- those functions
 * were shipped rendering nothing (weatherSnapshot always undefined) until
 * this file existed. See claude/psac-adventure-hub-lifecycle-alerts-
 * proposal-2026-09-03.md for the original design.
 *
 * Deliberately side-effect-free and auth-agnostic, same posture as
 * lib/validate-address.js (the other Google Maps Platform caller in this
 * codebase, sharing the same GOOGLE_MAPS_API_KEY): callers own their own
 * auth and their own fallback when this returns null. Soft-fails on
 * EVERY failure mode -- missing key, unknown town, network/API error, or
 * a trip date outside the data Google actually has -- rather than
 * throwing or fabricating a number, because a blank weather card is a
 * fine fallback and a wrong one is not, for a real guest making
 * outdoor-safety decisions on trail day.
 *
 * The Weather API is lat/lng-only and documents a coverage gap for
 * "remote locations... deserts, mountain tops" -- exactly where these
 * trailheads sit. Per the lifecycle-alerts proposal, this deliberately
 * queries each trail's NEAREST TOWN (trails.nearest_town, a real
 * populated place -- see db/2026-09-04_add_trails_nearest_town.sql) via
 * the small hardcoded coordinate table below, not the trailhead's own
 * GPS -- both because of the coverage gap and because trailhead_gps is
 * sparse and stored as a '33.7890° N, 116.5214° W' display string, not a
 * decimal float pair ready to hand to an API.
 */

'use strict';

const CURRENT_ENDPOINT = 'https://weather.googleapis.com/v1/currentConditions:lookup';
const FORECAST_ENDPOINT = 'https://weather.googleapis.com/v1/forecast/days:lookup';

// Approximate downtown/civic-center point for each Coachella Valley town
// trails.nearest_town can hold. Good enough for a "what's it like outside
// today" glance card -- not a precision siting tool, and weather doesn't
// vary meaningfully across a few miles of open desert anyway.
const TOWN_COORDS = {
  'Palm Springs': { lat: 33.8303, lng: -116.5453 },
  'Cathedral City': { lat: 33.7803, lng: -116.4653 },
  'Rancho Mirage': { lat: 33.7397, lng: -116.4128 },
  'Palm Desert': { lat: 33.7226, lng: -116.3744 },
  'Indian Wells': { lat: 33.7175, lng: -116.3406 },
  'La Quinta': { lat: 33.6634, lng: -116.3100 },
  Indio: { lat: 33.7206, lng: -116.2156 },
  Coachella: { lat: 33.6803, lng: -116.1739 },
  'Desert Hot Springs': { lat: 33.9611, lng: -116.5017 },
  'Thousand Palms': { lat: 33.8181, lng: -116.3739 },
};

const FALLBACK_TOWN = 'Palm Springs';

// Forecast/days:lookup's documented window is 10 days (index 0 = today).
// Past that, there's nothing honest to show -- the hub re-fetches its
// context on every load, so the card fills itself in once the trip
// enters range rather than needing a cron or cache to catch up.
const MAX_FORECAST_OFFSET = 9;

function humanizeConditionType(type) {
  if (!type) return '';
  return String(type)
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// WeatherCondition objects carry both a localized human-readable
// description.text and a raw type enum (CLEAR, PARTLY_CLOUDY, ...) --
// prefer the former, fall back to a humanized version of the latter so a
// response shape Google changes slightly still renders something sane
// instead of an empty condition string.
function conditionLabel(weatherCondition) {
  if (!weatherCondition) return '';
  return (weatherCondition.description && weatherCondition.description.text) || humanizeConditionType(weatherCondition.type);
}

// Trip dates are whole calendar dates with no meaningful time-of-day
// component (a Postgres DATE column, a 'YYYY-MM-DD' string, or a JS
// Date). Normalizing everything to UTC midnight for diffing avoids
// DST-adjacent off-by-one errors without needing real timezone-aware
// date math here -- this only needs to know how many calendar days away
// the trip is, not what time it is in Palm Springs right now.
function toDateOnly(d) {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const parts = s.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function daysUntil(tripDate) {
  const today = toDateOnly(new Date());
  const trip = toDateOnly(tripDate);
  return Math.round((trip.getTime() - today.getTime()) / 86400000);
}

async function callGoogle(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) {
    throw new Error((json && json.error && json.error.message) || `Google Weather API error: ${res.status}`);
  }
  return json;
}

/**
 * @param {string} nearestTown - trails.nearest_town value for the
 *   booking's selected trail. Unrecognized/missing values fall back to
 *   Palm Springs (the valley's largest town and where most seeded trails
 *   already sit) rather than returning null outright, so one bad or
 *   not-yet-reviewed nearest_town value doesn't blank the whole card.
 * @param {string|Date} tripDate - the booking's trip date.
 * @returns {Promise<{tempF:number, condition:string, detail:string}|null}>}
 */
async function getWeatherSnapshot(nearestTown, tripDate) {
  if (!process.env.GOOGLE_MAPS_API_KEY) return null;
  if (!tripDate) return null;

  const coords = TOWN_COORDS[nearestTown] || TOWN_COORDS[FALLBACK_TOWN];
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const locationParams = `location.latitude=${coords.lat}&location.longitude=${coords.lng}`;

  let offset;
  try {
    offset = daysUntil(tripDate);
  } catch (err) {
    return null;
  }

  try {
    if (offset <= 0) {
      // Trip is today (or, degenerate case, already past) -- current
      // conditions is the honest read; a "forecast" for today would just
      // be a noisier version of the same number.
      const json = await callGoogle(`${CURRENT_ENDPOINT}?key=${key}&${locationParams}&unitsSystem=IMPERIAL`);
      const tempF = json.temperature && json.temperature.degrees != null ? Math.round(json.temperature.degrees) : null;
      if (tempF == null) return null;
      const feelsLike = json.feelsLikeTemperature && json.feelsLikeTemperature.degrees != null
        ? Math.round(json.feelsLikeTemperature.degrees)
        : null;
      return {
        tempF,
        condition: conditionLabel(json.weatherCondition),
        detail: feelsLike != null && feelsLike !== tempF ? `Feels like ${feelsLike}°F` : '',
      };
    }

    if (offset > MAX_FORECAST_OFFSET) return null;

    const json = await callGoogle(`${FORECAST_ENDPOINT}?key=${key}&${locationParams}&unitsSystem=IMPERIAL&days=10`);
    const days = json.forecastDays || [];
    const today0 = toDateOnly(new Date()).getTime();
    const match = days.find((d) => {
      const dd = d.displayDate;
      if (!dd) return false;
      const dt = Date.UTC(dd.year, dd.month - 1, dd.day);
      return Math.round((dt - today0) / 86400000) === offset;
    }) || days[offset];
    if (!match) return null;

    const maxT = match.maxTemperature && match.maxTemperature.degrees != null ? Math.round(match.maxTemperature.degrees) : null;
    const minT = match.minTemperature && match.minTemperature.degrees != null ? Math.round(match.minTemperature.degrees) : null;
    if (maxT == null) return null;
    const daytimeCondition = match.daytimeForecast && match.daytimeForecast.weatherCondition;

    return {
      tempF: maxT,
      condition: conditionLabel(daytimeCondition),
      detail: minT != null ? `Low ${minT}°F` : '',
    };
  } catch (err) {
    return null;
  }
}

module.exports = { getWeatherSnapshot, TOWN_COORDS };
