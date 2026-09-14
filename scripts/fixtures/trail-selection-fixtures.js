'use strict';
/**
 * scripts/fixtures/trail-selection-fixtures.js
 *
 * Auto-generated (2026-09-14) from the real db/seed.sql +
 * db/2026-09-03_add_trails_039-052.sql INSERT statements, filtered to the
 * 19 trails Section 1 of claude/psac-trail-selection-diagnosis-and-test-plan-2026-09-12.md
 * confirms bookable today, with the corrections Airey supplied directly
 * layered on top (Oswit Canyon's park value + bookable flip; the
 * TRAIL-051/052 park-name fix). See PARK_OVERRIDES/BOOKABLE_OVERRIDES in
 * the generator script (kept in this session's scratchpad, not checked in)
 * for exactly what was overridden and why.
 *
 * CAVEAT: this is a snapshot derived from repo migration files, which are
 * NOT guaranteed complete -- the Trails & Parks CRUD admin screen
 * (shipped 2026-09-03) lets staff edit trails/park_access directly in
 * production with no corresponding SQL file ever committed. The Oswit
 * Canyon park_access row below is a documented ASSUMPTION for exactly
 * this reason (see its _assumption field) -- no such row exists in any
 * migration file, yet the live admin screen shows "Oswit Canyon" as a
 * valid, dropdown-sourced Park value, meaning it was added out-of-band.
 * Re-generate or hand-correct this file if the live database diverges
 * further from repo history.
 */

const TRAILS = [
  {
    "trailId": "TRAIL-029",
    "trailName": "Oswit Canyon",
    "bookable": true,
    "park": "Oswit Canyon",
    "trailheadLocation": "Oswit Canyon Trailhead",
    "easyPaceHours": "1 - 1.5 hours",
    "strongPaceHours": "20 mins",
    "difficulty": 1,
    "technicalRating": 1,
    "distance": 1.2,
    "elevation": 166,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Interesting geology",
      "Moving slow and taking it all in",
      "Solitude and quiet"
    ],
    "oneTripTip": null,
    "overviewCopy": "Oswit Canyon sits just south of the South Lykken trailhead, separated by a narrow wash, and is easy to walk past if you don't know to look for it. The trail is a short loop through an alluvial fan preserved by the Oswit Land Trust, saved from development and left to do what desert land does: grow ocotillo and creosote and barrel cactus and buckhorn cholla in the lumpy, mineral-rich soil that water and wind have been shaping for centuries. The path is wide and sandy going up, more rocky coming back, and gentle enough in either direction that a small child can do the whole loop unassisted. Most people walk it in under an hour. Some take considerably longer, depending on how many rocks need to be examined along the way.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-032",
    "trailName": "Andreas Canyon",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Andreas Canyon",
    "easyPaceHours": "45 mins",
    "strongPaceHours": "10 mins",
    "difficulty": 1,
    "technicalRating": 1,
    "distance": 0.9,
    "elevation": 118,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Wildlife and nature",
      "\"Water - streams",
      "pools",
      "falls\"",
      "Learning about the place",
      "Moving slow and taking it all in"
    ],
    "oneTripTip": null,
    "overviewCopy": "Andreas Canyon is the shortest loop in the Indian Canyons system and one of the most concentrated. The trail sign at the trailhead says one mile. It does not say how long you will stay. The canyon side of the loop runs inside the gorge with the creek alongside and the walls close. The rock here is layered and angular, stacked in deep reds and burnt orange, with grass tufts growing from ledges high above. In the tightest sections the palm fronds brush the canyon wall on one side and the stream runs a few feet below on the other. The trail is sandy and easy underfoot. Birds move through the canopy. The sound of running water stays with you the entire way. The creek is accessible throughout the canyon half of the loop. About a fifth of a mile in, it broadens over large boulders into the calmest and largest of several pools, cold and clear over a pebble bottom. This is where shoes come off. Stone structures are visible on the hillside above, fenced off and silent. A small sign mentions the Andreas Canyon Club, a group that bought this land from the Southern Pacific Railroad in the early 1900s. Almost no other explanation is offered. The trail gives you just enough to wonder. The return runs the opposite side of the canyon, open and exposed, with the full palm grove and rock formations visible across the gorge. From up here the scale becomes clear: a dense stand of hundreds of palms pressed against towering red rock, the creek hidden below. The views open across the mountain ranges beyond. On a warm day this side earns the shade you left behind.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-033",
    "trailName": "Murray Canyon Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Murray Canyon",
    "easyPaceHours": "1.5 - 2 hrs",
    "strongPaceHours": "0.5 - 1 hr",
    "difficulty": 2,
    "technicalRating": 3,
    "distance": 2.6,
    "elevation": 441,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Wildlife and nature",
      "\"Water - streams",
      "pools",
      "falls\"",
      "Learning about the place",
      "Moving slow and taking it all in"
    ],
    "oneTripTip": null,
    "overviewCopy": "Murray Canyon begins as a promise you can see before you earn it. From the fire road out of the parking lot, the palms are already visible ahead, rising from the wash in a dense green line against the mountain. Most trails make you guess at what's coming. Murray Canyon shows you from the start. The trail follows the creek into the canyon, the path going soft and concave underfoot where decades of horse traffic have worn it into the earth. Watch for evidence of those horses. The palms thicken as the canyon walls close in, and the air cools. The trail moves in and out of tree cover, shaded under the palms, then open again beside them, but the canyon walls do the heavier work of keeping the morning cool. The stream crossings are real crossings, stone to stone over moving water, the kind that require a hand for small legs. Inside the canyon it is lush in a way that surprises people who think they know what the desert is. The return climbs the ridge above the canyon, and the trail becomes something entirely different. Below you, the palm grove threads through the canyon floor in a long green line. Ahead, the Coachella Valley opens wide, Palm Springs small and quiet in the distance, the Santa Rosa Mountains layered across the horizon. The finish is exposed and warms quickly. Start early.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-034",
    "trailName": "Murray Canyon Out & Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Murray Canyon",
    "easyPaceHours": "2 hrs",
    "strongPaceHours": ".75 - 1 hr",
    "difficulty": 2,
    "technicalRating": 3,
    "distance": 2.6,
    "elevation": 322,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "\"Water - streams",
      "pools",
      "falls\"",
      "Photography opportunities",
      "Wildlife and nature"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-035",
    "trailName": "Seven Falls Out & Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Murray Canyon",
    "easyPaceHours": "2.5 - 3 hrs",
    "strongPaceHours": "1 - 1.5 hrs",
    "difficulty": 3,
    "technicalRating": 3,
    "distance": 3.5,
    "elevation": 527,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "\"Water - streams",
      "pools",
      "falls\"",
      "Interesting geology",
      "Wildlife and nature"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-036",
    "trailName": "Seven Falls Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Murray Canyon",
    "easyPaceHours": "3 - 4 hrs",
    "strongPaceHours": "1.5 - 2 hrs",
    "difficulty": 3,
    "technicalRating": 3,
    "distance": 4.3,
    "elevation": 716,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "\"Water - streams",
      "pools",
      "falls\"",
      "Interesting geology",
      "Big Views",
      "Photography opportunities"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-037",
    "trailName": "Fern Canyon Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Victor Trail",
    "easyPaceHours": "3 - 4 hrs",
    "strongPaceHours": "1 - 1.5 hrs",
    "difficulty": 4,
    "technicalRating": 3,
    "distance": 5.4,
    "elevation": 831,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Big Views",
      "Solitude and quiet",
      "Photography opportunities",
      "Interesting geology"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-038",
    "trailName": "East Fork Out & Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Palm Canyon",
    "easyPaceHours": "3 - 4 hrs",
    "strongPaceHours": "1.5 - 2 hrs",
    "difficulty": 3,
    "technicalRating": 4,
    "distance": 5.6,
    "elevation": 789,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Oct",
    "viableSeason": "May, Sep, Apr",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Solitude and quiet",
      "Big Views",
      "Interesting geology",
      "Wildlife and nature",
      "Photography opportunities"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-039",
    "trailName": "East Fork Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Victor Trail",
    "easyPaceHours": "3 - 4 hrs",
    "strongPaceHours": "1.5 - 2 hrs",
    "difficulty": 4,
    "technicalRating": 4,
    "distance": 7.5,
    "elevation": 1338,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Solitude and quiet",
      "Interesting geology",
      "Photography opportunities",
      "Big Views"
    ],
    "oneTripTip": null,
    "overviewCopy": "East Fork Loop begins on the Victor Trail, a moderate undulating climb along a ridge above Palm Canyon. The palms are visible from up here as a green line threading through the rock far below. The mountains fill the horizon.\nThe trail drops into the East Fork wash at the canyon junction, where a small sign marks the transition: hazardous conditions beyond this point, no water, no shade, no cell service. The wash takes it from there.\nEast Fork runs the entire length of the wash, which means the trail is not beside the terrain but inside it. The canyon walls rise on both sides, layered orange and gold, cut through in places by white mineral veins pressed into the rock face. The floor shifts between open sandy corridors and tight narrows where the walls close in and prickly pear grows in the crevices above, blooming magenta in spring. Where water would normally cascade down through the rock, the trail scrambles over it instead. Fountain grass grows thick in the shadow zones. At the dry waterfall floors the stone turns smooth and grey, a different material entirely from the orange walls surrounding it. Watch where you step in the wash. The canyon is genuinely wild.\nThe wash ends at mile 3.5. The trail climbs left onto the plateau and the landscape opens completely. Desert scrub in every direction, the Coachella Valley spread to the east, San Jacinto rising to the west with snow on the summit in winter and early spring. And then, below: the palms. A dense green stand tucked into the canyon you just walked through, fed by water that runs through the wash when it rains, invisible from inside, visible only from here.\nVandeventer descends toward Palm Canyon. The palms appear first as treetops, then the canyon opens and the creek is running, granite boulders in the shade, fan palms overhead. After miles of dry exposure, the sound of water is unexpected. The loop deposits you back where you started having moved through three entirely different versions of the same mountain.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-040",
    "trailName": "West Fork Out & Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Palm Canyon",
    "easyPaceHours": "3.5 - 4.5 hrs",
    "strongPaceHours": "1.5 - 2 hrs",
    "difficulty": 4,
    "technicalRating": 5,
    "distance": 4.7,
    "elevation": 1438,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Nov, Dec",
    "viableSeason": "Apr, Mar, Oct",
    "avoidSeason": "Jun, Jul, Aug, May, Sep",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Big Views",
      "Solitude and quiet",
      "Interesting geology",
      "Photography opportunities",
      "Wildlife and nature"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-041",
    "trailName": "West Fork Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Murray Canyon",
    "easyPaceHours": "4 - 6 hrs",
    "strongPaceHours": "2.5 - 3.5 hrs",
    "difficulty": 5,
    "technicalRating": 5,
    "distance": 9.69,
    "elevation": 2601,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Nov, Dec",
    "viableSeason": "Apr, Mar, Oct",
    "avoidSeason": "Jun, Jul, Aug, May, Sep",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Big Views",
      "Solitude and quiet",
      "Wildlife and nature",
      "Water - streams, pools, falls",
      "Photography opportunities"
    ],
    "oneTripTip": null,
    "overviewCopy": "You arrive carrying something. Most people do. It sits in the back of your mind and rests in the tension of your shoulders. The pool hasn't been able to shake it off.\nThe drive into Indian Canyons helps. Ancient palms where water runs down from the mountains. Canyon walls rising until the city disappears behind you. By the time you reach the West Fork sign, something has already begun to loosen. Most people who came this far today will turn back here. That's part of what makes going forward feel like a choice that belongs entirely to you.\nThree switchbacks up, you lose the sound of other people. Then a hazard sign. No water, no shade, no cell service. Your phone confirms it. You pause. And then something unexpected: you feel alive.\nThe trail climbs quickly. Boulder fields, slanted rock, grinding switchbacks interrupted by descents that arrive as pure relief. Hidden palm stands appear in the canyons below. A glimpse of Palm Springs surfaces between ridgelines behind you, small and distant. Somewhere in the effort, your mind stops competing with itself.\nThe cottonwood arrives before the water does. A single tree, green in a way nothing else out here is green. Then the sound. Then the stream, cold and clear, running through a canyon that almost no one reaches.\n\nCross the stream. You'll understand why you came.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-042",
    "trailName": "Palm Canyon Out and Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Palm Canyon",
    "easyPaceHours": "1 - 1.5 hrs",
    "strongPaceHours": ".5 hrs",
    "difficulty": 2,
    "technicalRating": 2,
    "distance": 2,
    "elevation": 217,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Wildlife and nature",
      "Interesting geology",
      "Water - streams, pools, falls",
      "Photography opportunities",
      "Learning about the place"
    ],
    "oneTripTip": null,
    "overviewCopy": "The palm grove is visible before the trail begins. From the ranger station, the canyon below holds hundreds of fan palms, packed along the creek line, the canopy so dense it reads as a single green mass between the canyon walls. Victor Trail climbs the opposite ridge first.\nThe climb is exposed and warm, with the grove visible across the canyon the entire way up. From the ridge you can see the full scale of it: the palms filling the canyon floor from wall to wall, the creek line marked in green, the mountains rising behind. This is the above-canyon view. Then the trail descends toward it.\nThe transition into Palm Canyon is immediate. Within a few steps the trunks close overhead, the temperature drops, and the trail runs between the palms along the creek. Some of the trunks carry fire scars at the base, black against the pale bark, with new fronds pushing through above. At the widest section of the grove the trail straightens and San Jacinto appears framed at the far end of the corridor, snow on the summit in winter and early spring. The return follows the creek back to the trailhead with gentle undulation through the shade.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-043",
    "trailName": "Stone Pools Out and Back",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Palm Canyon",
    "easyPaceHours": "3 - 4 hrs",
    "strongPaceHours": "1.5 - 2 hrs",
    "difficulty": 3,
    "technicalRating": 3,
    "distance": 6.6,
    "elevation": 1095,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Interesting geology",
      "Water - streams, pools, falls",
      "Big Views",
      "Wildlife and nature",
      "Photography opportunities"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-044",
    "trailName": "Victor - Palm Canyon Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Victor Trail",
    "easyPaceHours": "1.5 - 2 hours",
    "strongPaceHours": "45 mins",
    "difficulty": 3,
    "technicalRating": 3,
    "distance": 2.7,
    "elevation": 505,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": true,
    "minAgeRec": 12,
    "bestForAttributes": [
      "Big Views",
      "Water - streams, pools, falls",
      "Photography opportunities",
      "Learning about the place",
      "Moving slow and taking it all in"
    ],
    "oneTripTip": null,
    "overviewCopy": "The palm grove is visible before the trail begins. From the ranger station, the canyon below holds hundreds of fan palms, packed along the creek line, the canopy so dense it reads as a single green mass between the canyon walls. Victor Trail climbs the opposite ridge first.\nThe climb is exposed and warm, with the grove visible across the canyon the entire way up. From the ridge you can see the full scale of it: the palms filling the canyon floor from wall to wall, the creek line marked in green, the mountains rising behind. This is the above-canyon view. Then the trail descends toward it.\nThe transition into Palm Canyon is immediate. Within a few steps the trunks close overhead, the temperature drops, and the trail runs between the palms along the creek. Some of the trunks carry fire scars at the base, black against the pale bark, with new fronds pushing through above. At the widest section of the grove the trail straightens and San Jacinto appears framed at the far end of the corridor, snow on the summit in winter and early spring. The return follows the creek back to the trailhead with gentle undulation through the shade.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-045",
    "trailName": "Maynard Mine Trail",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Maynard Mine",
    "easyPaceHours": "4 - 6 hours",
    "strongPaceHours": "2.5 - 3 hours",
    "difficulty": 5,
    "technicalRating": 4,
    "distance": 5.7,
    "elevation": 2236,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Nov, Dec",
    "viableSeason": "Apr, Mar, Oct",
    "avoidSeason": "Jun, Jul, Aug, May, Sep",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Big Views",
      "Solitude and quiet",
      "Photography opportunities",
      "Water - streams, pools, falls"
    ],
    "oneTripTip": null,
    "overviewCopy": "Most visitors to Palm Springs never hear this trail's name. The ones who do usually see the hazard sign at the canyon entrance and turn around. What's beyond it is one of the most layered experiences the Indian Canyons system holds.\nThe trail begins gently. A spring-fed canyon where water sustains life, including a grand stand of fan palms that offer shade and a break from the heat on even the hottest of days. Wildflowers in season. The sound of running water in the desert does something to your nervous system before your mind has time to explain why. You stop thinking about what you left behind. The canyon has your full attention.\nThen the trail turns upward and asks you to dig deep. The climb is sustained and hard. But if you know where to look, the canyon drops away below you as you gain elevation, and deep in it, hidden from anyone who stayed on the valley floor, a waterfall. Most people hiking Palm Springs today have no idea it exists. You're looking down at it.\nYou crest the ridge and the world flips. The canyon behind you disappears. What opens in front of you is a descent along an exposed ridgeline on the far side of the mountain, loose underfoot, edges dropping away on both sides. This is where the trail asks the most of you. Focus sharpens. Everything else goes quiet.\nThe ones who make it down arrive at something quietly extraordinary. A mine that operated in near-total isolation from 1917 to 1932. The original compressor still on site. The mine entrance still visible. And spread below you, the entire Coachella Valley. Cathedral City, Palm Springs, Rancho Mirage. The same view the miners woke up to every morning, a hundred years before you got here.\nYou earned this one. It shows.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-047",
    "trailName": "Tahquitz Falls",
    "bookable": true,
    "park": "Tahquitz Canyon",
    "trailheadLocation": "Tahquitz Falls",
    "easyPaceHours": "1 - 1.5 hrs",
    "strongPaceHours": "0.5 - 1 hr",
    "difficulty": 2,
    "technicalRating": 2,
    "distance": 1.8,
    "elevation": 281,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep, Jun, Jul, Aug",
    "avoidSeason": null,
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Water - streams, pools, falls",
      "Wildlife and nature",
      "Photography opportunities",
      "Moving slow and taking it all in"
    ],
    "oneTripTip": null,
    "overviewCopy": "Tahquitz Canyon is Agua Caliente tribal land, and entering it feels like crossing into a different world from the one you parked in. The visitor center collects the entrance fee and checks your water before you head in, a small ritual that signals this place takes itself seriously. The trail follows Tahquitz Creek into the canyon, crossing on low footbridges where you can dangle your feet over the edge and feel the cold moving underneath. Early on, remnants of the original Palm Springs water works appear along the creek: concrete channels and iron fittings that once routed this water into downtown, now sitting quietly as proof of what it took to build a city in the desert. The canyon walls close in gradually, cottonwood trees and wild grapevines crowd the water's edge, and the falls announce themselves before you see them.",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-050",
    "trailName": "East Fork - Stone Pools Loop",
    "bookable": true,
    "park": "Indian Canyons",
    "trailheadLocation": "Palm Canyon",
    "easyPaceHours": "4 - 5 hrs",
    "strongPaceHours": "2 - 2.5 hrs",
    "difficulty": 4,
    "technicalRating": 4,
    "distance": 8.5,
    "elevation": 1297,
    "activityType": [
      "Hiking",
      "Trail Running"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": false,
    "minAgeRec": 16,
    "bestForAttributes": [
      "Interesting geology",
      "Wildlife and nature",
      "Solitude and quiet",
      "Big Views",
      "Photography opportunities",
      "Water - streams, pools, falls",
      "Moving fast"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-051",
    "trailName": "McCallum Pond Loop",
    "bookable": true,
    "park": "Coachella Valley Preserve: Thousand Palms Oasis",
    "trailheadLocation": "McCallum Trail",
    "easyPaceHours": "1.5 - 2 hrs",
    "strongPaceHours": ".75 - 1 hr",
    "difficulty": 2,
    "technicalRating": 2,
    "distance": 2,
    "elevation": 110,
    "activityType": [
      "Hiking"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Interesting geology",
      "Water - streams, pools, falls",
      "Photography opportunities",
      "Learning about the place",
      "Wildlife and nature"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  },
  {
    "trailId": "TRAIL-052",
    "trailName": "Mumawet and Andreas Fault",
    "bookable": true,
    "park": "Coachella Valley Preserve: Thousand Palms Oasis",
    "trailheadLocation": "Coachella Valley Preserve Parking Lot",
    "easyPaceHours": "1 - 1.5 hrs",
    "strongPaceHours": ".5 - .75 hr",
    "difficulty": 2,
    "technicalRating": 1,
    "distance": 1.2,
    "elevation": 106,
    "activityType": [
      "Hiking"
    ],
    "optimalSeason": "Jan, Feb, Mar, Nov, Dec, Apr, Oct",
    "viableSeason": "May, Sep",
    "avoidSeason": "Jun, Jul, Aug",
    "kidFriendly": true,
    "minAgeRec": 4,
    "bestForAttributes": [
      "Interesting geology",
      "Water - streams, pools, falls",
      "Photography opportunities",
      "Learning about the place",
      "Wildlife and nature"
    ],
    "oneTripTip": null,
    "overviewCopy": "",
    "photoUrl": null
  }
];

const PARK_ACCESS = [
  {
    "park": "Indian Canyons",
    "season": "Oct 2-Jul 5",
    "applicableDays": null,
    "openingTime": "8:00 AM",
    "closingTime": "4:00 PM",
    "adultFee": "$12",
    "childFee": "$6"
  },
  {
    "park": "Indian Canyons",
    "season": "Jul 6-Oct 1",
    "applicableDays": [
      "Fri",
      "Sat",
      "Sun"
    ],
    "openingTime": "8:00 AM",
    "closingTime": "4:00 PM",
    "adultFee": "$12",
    "childFee": "$6"
  },
  {
    "park": "Tahquitz Canyon",
    "season": "Oct 2-Jul 5",
    "applicableDays": null,
    "openingTime": "7:30 AM",
    "closingTime": "3:30 PM",
    "adultFee": "$15",
    "childFee": "$7"
  },
  {
    "park": "Tahquitz Canyon",
    "season": "Jul 6-Oct 1",
    "applicableDays": [
      "Fri",
      "Sat",
      "Sun"
    ],
    "openingTime": "7:30 AM",
    "closingTime": "3:30 PM",
    "adultFee": "$15",
    "childFee": "$7"
  },
  {
    "park": "Coachella Valley Preserve: Thousand Palms Oasis",
    "season": "May 1-Oct 31",
    "applicableDays": [
      "Sat",
      "Sun"
    ],
    "openingTime": "7:00 AM",
    "closingTime": "3:00 PM",
    "adultFee": "$0",
    "childFee": "$0"
  },
  {
    "park": "Coachella Valley Preserve: Thousand Palms Oasis",
    "season": "Nov 1-Apr 30",
    "applicableDays": [
      "Sat",
      "Sun"
    ],
    "openingTime": "7:00 AM",
    "closingTime": "3:00 PM",
    "adultFee": "$0",
    "childFee": "$0"
  },
  {
    "park": "Coachella Valley Preserve: Pushawalla & Willis Palms",
    "season": "Year-round",
    "applicableDays": null,
    "openingTime": "12:00 AM",
    "closingTime": "11:59 PM",
    "adultFee": "$0",
    "childFee": "$0"
  },
  {
    "park": "Oswit Canyon",
    "season": "Year-round",
    "applicableDays": null,
    "openingTime": "12:00 AM",
    "closingTime": "11:59 PM",
    "adultFee": "$0",
    "childFee": "$0",
    "_assumption": "ASSUMED, not confirmed: no park_access row for \"Oswit Canyon\" exists in any repo migration file. Airey's Trails admin screenshot shows the Park dropdown value as \"Oswit Canyon\" (dropdown is sourced from real park_access.park values per the build log), so a matching row must exist in production, added directly via the ops UI rather than a checked-in migration. Modeled here as open every day, year-round, no fee -- consistent with Oswit Land Trust being fully-permitted, no-permission-required land per the permitting project record -- but this exact schedule is NOT independently confirmed. Verify against the live Parks admin screen before trusting any date-axis test that depends on it."
  }
];

module.exports = { TRAILS, PARK_ACCESS };
