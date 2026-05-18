/**
 * VéloCoach Backend — server.js
 * Compatible Node.js 22+ (utilise node:sqlite natif, pas de Python requis)
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { DatabaseSync } from "node:sqlite";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173", credentials: true }));
app.use(express.json());

// ── Base de données SQLite native Node.js 26 ──────────────────────────────────
const db = new DatabaseSync(process.env.DB_PATH || "./velocoach.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS athletes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id     INTEGER UNIQUE NOT NULL,
    firstname     TEXT,
    lastname      TEXT,
    profile_pic   TEXT,
    ftp           INTEGER DEFAULT 0,
    weight        REAL DEFAULT 70,
    access_token  TEXT,
    refresh_token TEXT,
    token_expires INTEGER,
    created_at    INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS activities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id        INTEGER UNIQUE NOT NULL,
    athlete_id       INTEGER NOT NULL,
    name             TEXT,
    date             TEXT,
    distance_km      REAL,
    duration_sec     INTEGER,
    elevation_m      INTEGER,
    avg_power        INTEGER,
    normalized_power INTEGER,
    avg_hr           INTEGER,
    max_hr           INTEGER,
    tss              REAL,
    if_factor        REAL,
    avg_speed_kmh    REAL,
    sport_type       TEXT,
    synced_at        INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS fitness (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id INTEGER NOT NULL,
    date       TEXT,
    ctl        REAL,
    atl        REAL,
    tsb        REAL,
    tss_day    REAL,
    UNIQUE(athlete_id, date)
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function refreshTokenIfNeeded(athlete) {
  if (Date.now() / 1000 < athlete.token_expires - 60) return athlete.access_token;
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: athlete.refresh_token,
    }),
  });
  const data = await res.json();
  db.prepare(`UPDATE athletes SET access_token=?, refresh_token=?, token_expires=? WHERE id=?`)
    .run(data.access_token, data.refresh_token, data.expires_at, athlete.id);
  return data.access_token;
}

function computeTSS(np, ftp, durationSec) {
  if (!np || !ftp || !durationSec) return 0;
  const if_ = np / ftp;
  return (durationSec * np * if_) / (ftp * 3600) * 100;
}

function computeFitness(athleteId) {
  const activities = db.prepare(`
    SELECT date, tss FROM activities
    WHERE athlete_id = ? AND sport_type IN ('Ride','VirtualRide','MountainBikeRide','GravelRide')
    ORDER BY date ASC
  `).all(athleteId);
  if (!activities.length) return;

  const tssByDay = {};
  for (const a of activities) {
    const d = a.date.slice(0, 10);
    tssByDay[d] = (tssByDay[d] || 0) + (a.tss || 0);
  }

  const startDate = new Date(activities[0].date.slice(0, 10));
  const today = new Date();
  const CTL_DECAY = Math.exp(-1 / 42);
  const ATL_DECAY = Math.exp(-1 / 7);
  let ctl = 0, atl = 0;

  const upsert = db.prepare(`
    INSERT INTO fitness (athlete_id, date, ctl, atl, tsb, tss_day)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(athlete_id, date) DO UPDATE SET ctl=excluded.ctl, atl=excluded.atl, tsb=excluded.tsb, tss_day=excluded.tss_day
  `);

  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const tss = tssByDay[date] || 0;
    ctl = ctl * CTL_DECAY + tss * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + tss * (1 - ATL_DECAY);
    upsert.run(athleteId, date, ctl, atl, ctl - atl, tss);
  }
}

async function syncActivities(athlete) {
  const token = await refreshTokenIfNeeded(athlete);
  const ftp = athlete.ftp || 200;
  let page = 1, total = 0;

  const insert = db.prepare(`
    INSERT OR REPLACE INTO activities
      (strava_id, athlete_id, name, date, distance_km, duration_sec, elevation_m,
       avg_power, normalized_power, avg_hr, max_hr, tss, if_factor, avg_speed_kmh, sport_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  while (true) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const acts = await res.json();
    if (!Array.isArray(acts) || !acts.length) break;

    for (const a of acts) {
      const np = a.weighted_average_watts || a.average_watts || 0;
      const tss = computeTSS(np, ftp, a.elapsed_time);
      const if_ = ftp > 0 ? np / ftp : 0;
      insert.run(
        a.id, athlete.id, a.name,
        a.start_date_local.slice(0, 10),
        parseFloat((a.distance / 1000).toFixed(2)),
        a.elapsed_time,
        Math.round(a.total_elevation_gain),
        a.average_watts || 0, np,
        a.average_heartrate || 0, a.max_heartrate || 0,
        parseFloat(tss.toFixed(1)),
        parseFloat(if_.toFixed(3)),
        parseFloat(((a.average_speed || 0) * 3.6).toFixed(1)),
        a.sport_type || a.type
      );
    }
    total += acts.length;
    if (acts.length < 200) break;
    page++;
  }

  computeFitness(athlete.id);
  return total;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.get("/auth/strava", (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: process.env.STRAVA_REDIRECT_URI,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all,profile:read_all",
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`${process.env.FRONTEND_URL}?auth_error=${error}`);
  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code, grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    const a = data.athlete;

    db.prepare(`
      INSERT INTO athletes (strava_id, firstname, lastname, profile_pic, ftp, weight, access_token, refresh_token, token_expires)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(strava_id) DO UPDATE SET
        access_token=excluded.access_token, refresh_token=excluded.refresh_token,
        token_expires=excluded.token_expires, firstname=excluded.firstname, profile_pic=excluded.profile_pic
    `).run(a.id, a.firstname, a.lastname, a.profile_medium || a.profile, a.ftp || 0, a.weight || 70,
           data.access_token, data.refresh_token, data.expires_at);

    const athlete = db.prepare("SELECT * FROM athletes WHERE strava_id=?").get(a.id);
    syncActivities(athlete).catch(console.error);
    res.redirect(`${process.env.FRONTEND_URL}?athlete_id=${athlete.id}&syncing=true`);
  } catch (e) {
    console.error(e);
    res.redirect(`${process.env.FRONTEND_URL}?auth_error=server`);
  }
});

// ── Middleware auth ───────────────────────────────────────────────────────────
function requireAthlete(req, res, next) {
  const id = req.headers["x-athlete-id"];
  if (!id) return res.status(401).json({ error: "Non authentifié" });
  const athlete = db.prepare("SELECT * FROM athletes WHERE id=?").get(id);
  if (!athlete) return res.status(404).json({ error: "Athlète introuvable" });
  req.athlete = athlete;
  next();
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get("/api/athlete", requireAthlete, async (req, res) => {
  try {
    const token = await refreshTokenIfNeeded(req.athlete);
    const sa = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json());
    if (sa.ftp) db.prepare("UPDATE athletes SET ftp=? WHERE id=?").run(sa.ftp, req.athlete.id);
    const stats = db.prepare(`
      SELECT COUNT(*) as total_rides, SUM(distance_km) as total_km,
             SUM(elevation_m) as total_elev, SUM(duration_sec) as total_sec
      FROM activities WHERE athlete_id=?
    `).get(req.athlete.id);
    res.json({
      id: req.athlete.id, strava_id: req.athlete.strava_id,
      firstname: sa.firstname || req.athlete.firstname,
      lastname: sa.lastname || req.athlete.lastname,
      profile_pic: sa.profile_medium || req.athlete.profile_pic,
      ftp: sa.ftp || req.athlete.ftp,
      weight: sa.weight || req.athlete.weight,
      country: sa.country, stats,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/activities", requireAthlete, (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  const activities = db.prepare(`
    SELECT * FROM activities WHERE athlete_id=?
    ORDER BY date DESC LIMIT ? OFFSET ?
  `).all(req.athlete.id, limit, offset);
  const { total } = db.prepare("SELECT COUNT(*) as total FROM activities WHERE athlete_id=?").get(req.athlete.id);
  res.json({ activities, total });
});

app.get("/api/activities/:stravaId/streams", requireAthlete, async (req, res) => {
  try {
    const token = await refreshTokenIfNeeded(req.athlete);
    const [streams, detail] = await Promise.all([
      fetch(`https://www.strava.com/api/v3/activities/${req.params.stravaId}/streams?keys=altitude,watts,heartrate,velocity_smooth,distance,grade_smooth&key_by_type=true`,
        { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`https://www.strava.com/api/v3/activities/${req.params.stravaId}`,
        { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]);
    res.json({ streams, detail });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/fitness", requireAthlete, (req, res) => {
  const days = parseInt(req.query.days) || 90;
  const rows = db.prepare(`
    SELECT * FROM fitness WHERE athlete_id=? ORDER BY date DESC LIMIT ?
  `).all(req.athlete.id, days);
  const today = rows[0];
  res.json({
    history: rows.reverse(),
    current: today
      ? { ctl: Math.round(today.ctl), atl: Math.round(today.atl), tsb: Math.round(today.tsb) }
      : { ctl: 0, atl: 0, tsb: 0 },
  });
});

app.post("/api/sync", requireAthlete, async (req, res) => {
  try {
    const count = await syncActivities(req.athlete);
    res.json({ synced: count, message: `${count} activités synchronisées` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/athlete/ftp", requireAthlete, (req, res) => {
  const { ftp } = req.body;
  if (!ftp || ftp < 50 || ftp > 600) return res.status(400).json({ error: "FTP invalide" });
  db.prepare("UPDATE athletes SET ftp=? WHERE id=?").run(ftp, req.athlete.id);
  computeFitness(req.athlete.id);
  res.json({ ftp });
});

// ── Webhooks Strava ───────────────────────────────────────────────────────────
app.get("/webhooks/strava", (req, res) => {
  const { "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) res.json({ "hub.challenge": challenge });
  else res.status(403).json({ error: "Token invalide" });
});

app.post("/webhooks/strava", async (req, res) => {
  res.sendStatus(200);
  const { object_type, aspect_type, object_id, owner_id } = req.body;
  if (object_type !== "activity" || aspect_type !== "create") return;
  try {
    const athlete = db.prepare("SELECT * FROM athletes WHERE strava_id=?").get(owner_id);
    if (!athlete) return;
    const token = await refreshTokenIfNeeded(athlete);
    const activity = await fetch(`https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    const ftp = athlete.ftp || 200;
    const np = activity.weighted_average_watts || activity.average_watts || 0;
    const tss = computeTSS(np, ftp, activity.elapsed_time);
    db.prepare(`
      INSERT OR REPLACE INTO activities
        (strava_id, athlete_id, name, date, distance_km, duration_sec, elevation_m,
         avg_power, normalized_power, avg_hr, max_hr, tss, if_factor, avg_speed_kmh, sport_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(activity.id, athlete.id, activity.name, activity.start_date_local.slice(0,10),
      parseFloat((activity.distance/1000).toFixed(2)), activity.elapsed_time,
      Math.round(activity.total_elevation_gain), activity.average_watts||0, np,
      activity.average_heartrate||0, activity.max_heartrate||0,
      parseFloat(tss.toFixed(1)), parseFloat((np/ftp).toFixed(3)),
      parseFloat(((activity.average_speed||0)*3.6).toFixed(1)),
      activity.sport_type||activity.type);
    computeFitness(athlete.id);
    console.log(`✅ Webhook: "${activity.name}" synchronisée`);
  } catch(e) { console.error("Webhook error:", e); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚴 VéloCoach backend démarré sur http://localhost:${PORT}`);
});

// ── PLAN D'ENTRAÎNEMENT ADAPTATIF ─────────────────────────────────────────────

function generateAdaptivePlan(athleteId, ftp) {
  // Récupère les 7 derniers jours de fitness
  const fitnessRows = db.prepare(`
    SELECT * FROM fitness WHERE athlete_id=? ORDER BY date DESC LIMIT 14
  `).all(athleteId);

  if (!fitnessRows.length) return getDefaultPlan(ftp);

  const today = fitnessRows[0];
  const ctl = today.ctl || 0;
  const atl = today.atl || 0;
  const tsb = today.tsb || 0;

  // Calcul de la charge cible hebdomadaire selon CTL
  const baseWeeklyTSS = Math.round(ctl * 7 * 0.85);
  const targetWeeklyTSS = Math.round(baseWeeklyTSS * (tsb > 5 ? 1.1 : tsb < -20 ? 0.7 : 1.0));

  // Détermine le niveau de forme
  const formLevel = tsb > 10 ? "peak" : tsb > 0 ? "good" : tsb > -20 ? "normal" : "tired";

  // Templates de séances selon la forme
  const sessions = {
    peak: [
      { type: "VO2max", zones: "Z5", duration: 75, tss: 105, detail: "5×4min à 110-120% FTP · récup 4min Z1" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 22, detail: "Sortie légère, cadence élevée" },
      { type: "Seuil", zones: "Z4", duration: 90, tss: 115, detail: "3×15min à 95-100% FTP · récup 5min" },
      { type: "Repos", zones: "—", duration: 0, tss: 0, detail: "Récupération complète" },
      { type: "Sprint/Anaérobie", zones: "Z6", duration: 60, tss: 85, detail: "10×30s sprint max · récup 4min Z1" },
      { type: "Long ride", zones: "Z2-Z3", duration: 210, tss: 155, detail: "Sortie longue endurance, 2 cols si possible" },
      { type: "Récupération", zones: "Z1", duration: 60, tss: 28, detail: "Filature, jambes légères" },
    ],
    good: [
      { type: "Endurance", zones: "Z2", duration: 90, tss: 65, detail: "Sortie Z2 régulière, cadence 85-95 rpm" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 22, detail: "Sortie légère active" },
      { type: "Tempo", zones: "Z3", duration: 75, tss: 88, detail: "2×20min tempo à 80-87% FTP" },
      { type: "Repos", zones: "—", duration: 0, tss: 0, detail: "Récupération complète" },
      { type: "Seuil", zones: "Z4", duration: 70, tss: 92, detail: "4×10min à 95-100% FTP · récup 3min" },
      { type: "Long ride", zones: "Z2-Z3", duration: 180, tss: 135, detail: "Sortie longue avec 2×30min tempo" },
      { type: "Récupération", zones: "Z1", duration: 60, tss: 28, detail: "Filature récupération" },
    ],
    normal: [
      { type: "Endurance", zones: "Z2", duration: 75, tss: 55, detail: "Z2 pur, maintien aérobie" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 20, detail: "Sortie très légère" },
      { type: "Tempo", zones: "Z3", duration: 60, tss: 70, detail: "30min continu à 78-85% FTP" },
      { type: "Repos", zones: "—", duration: 0, tss: 0, detail: "Repos actif : marche ou stretching" },
      { type: "Endurance", zones: "Z2", duration: 90, tss: 65, detail: "Z2 avec 3×5min Z3 inclus" },
      { type: "Long ride", zones: "Z2", duration: 150, tss: 110, detail: "Sortie longue Z2 strict" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 20, detail: "Filature légère" },
    ],
    tired: [
      { type: "Récupération", zones: "Z1", duration: 45, tss: 20, detail: "Sortie très légère, plaisir avant tout" },
      { type: "Repos", zones: "—", duration: 0, tss: 0, detail: "Repos complet obligatoire" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 20, detail: "Sortie légère si tu te sens mieux" },
      { type: "Repos", zones: "—", duration: 0, tss: 0, detail: "Sommeil et nutrition prioritaires" },
      { type: "Endurance légère", zones: "Z2", duration: 60, tss: 42, detail: "Z2 pur si énergie revenue" },
      { type: "Endurance", zones: "Z2", duration: 90, tss: 62, detail: "Reprise progressive en Z2" },
      { type: "Récupération", zones: "Z1", duration: 45, tss: 20, detail: "Filature légère" },
    ],
  };

  const days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const plan = sessions[formLevel].map((s, i) => ({
    ...s,
    day: days[i],
    done: false,
    today: i === new Date().getDay() === 0 ? 6 : new Date().getDay() - 1,
  }));

  // Marque aujourd'hui
  const todayIdx = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
  plan[todayIdx].today = true;

  return {
    plan,
    formLevel,
    tsb: Math.round(tsb),
    ctl: Math.round(ctl),
    atl: Math.round(atl),
    targetWeeklyTSS,
    advice: getAdvice(formLevel, tsb, ctl),
  };
}

function getAdvice(formLevel, tsb, ctl) {
  if (formLevel === "peak") return `Tu es en super forme (TSB +${Math.round(tsb)}) ! C'est le moment de pousser fort ou de viser une compétition.`;
  if (formLevel === "good") return `Bonne forme (TSB ${Math.round(tsb) > 0 ? "+" : ""}${Math.round(tsb)}). Continue sur cette lancée avec des séances de qualité.`;
  if (formLevel === "normal") return `Charge normale (TSB ${Math.round(tsb)}). Maintiens le volume, les gains viendront dans 2-3 semaines.`;
  return `Fatigue détectée (TSB ${Math.round(tsb)}). Priorité à la récupération — 2-3 jours légers avant de reprendre la charge.`;
}

function getDefaultPlan(ftp) {
  return {
    plan: [
      { day:"Lun", type:"Endurance", zones:"Z2", duration:90, tss:62, done:false, detail:"Z2 régulier" },
      { day:"Mar", type:"Récupération", zones:"Z1", duration:45, tss:22, done:false, detail:"Sortie légère" },
      { day:"Mer", type:"Seuil", zones:"Z4", duration:75, tss:95, done:false, detail:"3×12min à FTP" },
      { day:"Jeu", type:"Repos", zones:"—", duration:0, tss:0, done:false, detail:"Récupération" },
      { day:"Ven", type:"VO2max", zones:"Z5", duration:60, tss:88, done:false, today:true, detail:"5×3min à 115% FTP" },
      { day:"Sam", type:"Long ride", zones:"Z2-Z3", duration:180, tss:140, done:false, detail:"Sortie longue" },
      { day:"Dim", type:"Récupération", zones:"Z1", duration:60, tss:28, done:false, detail:"Filature" },
    ],
    formLevel: "normal",
    tsb: 0, ctl: 0, atl: 0,
    targetWeeklyTSS: 400,
    advice: "Configure ton FTP et synchronise tes activités pour obtenir un plan personnalisé.",
  };
}

// Route plan adaptatif
app.get("/api/plan", requireAthlete, (req, res) => {
  try {
    const plan = generateAdaptivePlan(req.athlete.id, req.athlete.ftp || 200);
    res.json(plan);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AMIS STRAVA RÉELS ─────────────────────────────────────────────────────────
app.get("/api/friends", requireAthlete, async (req, res) => {
  try {
    const token = await refreshTokenIfNeeded(req.athlete);

    // 1. Récupérer les athlètes suivis sur Strava
    const followingRes = await fetch(
      `https://www.strava.com/api/v3/athletes/${req.athlete.strava_id}/friends?per_page=30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // L'API Strava /friends est dépréciée — on utilise les activités du club ou les kudos
    // Alternative: récupérer les activités récentes du feed Strava
    const feedRes = await fetch(
      `https://www.strava.com/api/v3/activities/following?per_page=30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!feedRes.ok) {
      return res.json({ friends: [], message: "Accès au feed Strava limité" });
    }

    const feedActivities = await feedRes.json();

    // Regrouper par athlète unique
    const athleteMap = {};
    for (const act of feedActivities) {
      const a = act.athlete;
      if (!a || a.id === req.athlete.strava_id) continue;
      if (!athleteMap[a.id]) {
        athleteMap[a.id] = {
          strava_id: a.id,
          firstname: a.firstname,
          lastname: a.lastname,
          profile_pic: a.profile_medium || a.profile,
          activities: [],
          total_distance_km: 0,
          total_elevation_m: 0,
          last_activity: null,
        };
      }
      athleteMap[a.id].activities.push({
        name: act.name,
        date: act.start_date_local?.slice(0,10),
        distance_km: Math.round((act.distance||0)/1000*10)/10,
        elevation_m: act.total_elevation_gain||0,
        duration_sec: act.moving_time||0,
        avg_speed_kmh: act.average_speed ? Math.round(act.average_speed*3.6*10)/10 : 0,
        sport_type: act.sport_type||act.type,
        avg_watts: act.average_watts||0,
        suffer_score: act.suffer_score||0,
      });
      athleteMap[a.id].total_distance_km += (act.distance||0)/1000;
      athleteMap[a.id].total_elevation_m += act.total_elevation_gain||0;
      if (!athleteMap[a.id].last_activity || act.start_date_local > athleteMap[a.id].last_activity) {
        athleteMap[a.id].last_activity = act.start_date_local?.slice(0,10);
        athleteMap[a.id].last_activity_name = act.name;
        athleteMap[a.id].last_distance_km = Math.round((act.distance||0)/1000*10)/10;
        athleteMap[a.id].last_elevation_m = act.total_elevation_gain||0;
        athleteMap[a.id].last_duration_sec = act.moving_time||0;
        athleteMap[a.id].last_sport = act.sport_type||act.type;
      }
    }

    // Ajouter moi-même au classement avec mes vraies stats
    const myFitness = db.prepare(`SELECT * FROM fitness WHERE athlete_id=? ORDER BY date DESC LIMIT 1`).get(req.athlete.id);
    const myLastActivity = db.prepare(`SELECT * FROM activities WHERE athlete_id=? ORDER BY date DESC LIMIT 1`).get(req.athlete.id);
    const myWeekStats = db.prepare(`
      SELECT SUM(distance_km) as km, SUM(elevation_m) as elev, COUNT(*) as rides
      FROM activities WHERE athlete_id=? AND date >= date('now','-7 days')
    `).get(req.athlete.id);

    const me = {
      strava_id: req.athlete.strava_id,
      firstname: req.athlete.firstname,
      lastname: req.athlete.lastname,
      profile_pic: req.athlete.profile_pic,
      ftp: req.athlete.ftp,
      ctl: Math.round(myFitness?.ctl||0),
      atl: Math.round(myFitness?.atl||0),
      tsb: Math.round(myFitness?.tsb||0),
      week_km: Math.round(myWeekStats?.km||0),
      week_elev: Math.round(myWeekStats?.elev||0),
      week_rides: myWeekStats?.rides||0,
      last_activity: myLastActivity?.date,
      last_activity_name: myLastActivity?.name,
      last_distance_km: myLastActivity?.distance_km,
      last_elevation_m: myLastActivity?.elevation_m,
      last_sport: myLastActivity?.sport_type,
      isMe: true,
    };

    const friends = Object.values(athleteMap).map(f => ({
      ...f,
      total_distance_km: Math.round(f.total_distance_km),
      total_elevation_m: Math.round(f.total_elevation_m),
      activity_count: f.activities.length,
    }));

    res.json({ me, friends, total: friends.length });
  } catch(e) {
    console.error("Friends error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── PROFIL DE PUISSANCE RECORD (PPR) ─────────────────────────────────────────
// Calcule les meilleures puissances sur durées standard depuis toutes les activités
app.get("/api/ppr", requireAthlete, (req, res) => {
  try {
    const activities = db.prepare(`
      SELECT strava_id, name, date, avg_power, normalized_power, duration_sec, tss, if_factor
      FROM activities
      WHERE athlete_id=? AND sport_type IN ('Ride','VirtualRide','MountainBikeRide','GravelRide')
      AND avg_power > 0
      ORDER BY date DESC
    `).all(req.athlete.id);

    if (!activities.length) {
      return res.json({ ppr: null, message: "Pas assez de données de puissance" });
    }

    const ftp = req.athlete.ftp || 200;

    // Durées standard PPR (en secondes)
    const durations = [
      { sec: 5,    label: "5s",    desc: "Puissance neuromusculaire" },
      { sec: 15,   label: "15s",   desc: "Sprint anaérobie" },
      { sec: 30,   label: "30s",   desc: "Capacité anaérobie" },
      { sec: 60,   label: "1min",  desc: "Puissance maximale aérobie courte" },
      { sec: 300,  label: "5min",  desc: "VO2max" },
      { sec: 600,  label: "10min", desc: "Puissance aérobie" },
      { sec: 1200, label: "20min", desc: "Seuil fonctionnel (95% FTP)" },
      { sec: 3600, label: "1h",    desc: "FTP réel / endurance" },
    ];

    // Estimation des puissances max depuis avg_power et NP
    // Modèle de Monod-Scherrer: P(t) = W' / t + CP
    // Où CP ≈ FTP et W' ≈ capacité anaérobie
    // Pour chaque durée, on estime depuis les données disponibles

    // Relation puissance-durée (modèle empirique validé):
    // P(t) = FTP × (1 + k × (FTP_duration/t)^alpha)
    // Calibration standard cyclisme:
    const CP = ftp;  // Puissance critique ≈ FTP
    const Wprime = ftp * 120; // Capacité anaérobie ≈ 120 × FTP en joules (typique)

    // Calculer la meilleure puissance par durée depuis les activités réelles
    // On utilise NP comme proxy pour les efforts de durée moyenne
    // et avg_power pour les efforts longs

    const bestByDuration = durations.map(d => {
      let bestPower = 0;
      let bestActivity = null;

      for (const act of activities) {
        // Estimation puissance sur durée d.sec depuis avg_power de l'activité
        const actDuration = act.duration_sec;
        const avgP = act.avg_power;
        const np = act.normalized_power || avgP;

        if (actDuration <= 0 || avgP <= 0) continue;

        let estimatedPower;

        if (d.sec >= actDuration) {
          // Durée plus longue que l'activité → skip
          continue;
        } else if (d.sec >= actDuration * 0.8) {
          // Durée proche de la durée totale → utiliser avg_power
          estimatedPower = avgP * (actDuration / d.sec) * 0.98;
        } else if (d.sec >= 1200) {
          // Longue durée → modèle CP+W'
          estimatedPower = Math.min(np * 1.02, CP + Wprime / d.sec);
        } else if (d.sec >= 300) {
          // Durée moyenne → interpolation
          const ratio = Math.pow(actDuration / d.sec, 0.07);
          estimatedPower = np * ratio;
        } else {
          // Courte durée → modèle anaérobie
          const ratio = Math.pow(actDuration / d.sec, 0.12);
          estimatedPower = avgP * ratio;
          // Cap à valeurs physiologiquement réalistes
          const maxPhysio = ftp * (d.sec < 30 ? 4.0 : d.sec < 60 ? 2.5 : d.sec < 300 ? 1.6 : 1.3);
          estimatedPower = Math.min(estimatedPower, maxPhysio);
        }

        if (estimatedPower > bestPower) {
          bestPower = estimatedPower;
          bestActivity = { name: act.name, date: act.date, strava_id: act.strava_id };
        }
      }

      // Si pas de données, utiliser le modèle CP+W'
      if (bestPower === 0) {
        bestPower = Math.min(CP + Wprime / d.sec, ftp * 4.5);
      }

      const watts = Math.round(bestPower);
      const wPerKg = req.athlete.weight > 0 ? (watts / req.athlete.weight).toFixed(2) : null;
      const pctFTP = Math.round((watts / ftp) * 100);

      return {
        ...d,
        watts,
        wPerKg,
        pctFTP,
        bestActivity,
      };
    });

    // Identifier le profil cycliste depuis les ratios de puissance
    const p5s   = bestByDuration.find(d => d.sec === 5)?.watts || ftp * 3;
    const p1min = bestByDuration.find(d => d.sec === 60)?.watts || ftp * 1.5;
    const p5min = bestByDuration.find(d => d.sec === 300)?.watts || ftp * 1.2;
    const p20min = bestByDuration.find(d => d.sec === 1200)?.watts || ftp * 0.97;

    // Ratios normalisés par FTP
    const sprintRatio = p5s / ftp;      // > 3.5 = sprinteur
    const anaeRatio = p1min / ftp;      // > 1.6 = puncheur
    const vo2Ratio = p5min / ftp;       // > 1.25 = grimpeur VO2
    const threshRatio = p20min / ftp;   // > 0.97 = rouleur/grimpeur

    let profile = "rouleur";
    let profileLabel = "🚴 Rouleur";
    let profileDesc = "Tu excelles dans les efforts longs et réguliers. Idéal pour les granfondos et CLM.";
    let strengths = [];
    let weaknesses = [];

    if (sprintRatio > 3.5 && anaeRatio > 1.6) {
      profile = "sprinteur"; profileLabel = "⚡ Sprinteur";
      profileDesc = "Puissance explosive exceptionnelle. Redoutable en fin de course et sur terrain plat.";
      strengths = ["Sprint", "Relances courtes", "Terrain plat"];
      weaknesses = ["Longues ascensions", "Efforts > 30min"];
    } else if (anaeRatio > 1.55 && vo2Ratio > 1.22) {
      profile = "puncheur"; profileLabel = "🥊 Puncheur";
      profileDesc = "Tu combines puissance courte et bonne endurance. Redoutable sur les courses avec côtes répétées.";
      strengths = ["Cols courts", "Répétitions d'efforts", "Courses vallonnées"];
      weaknesses = ["Haute montagne", "Efforts très longs"];
    } else if (vo2Ratio > 1.22 && threshRatio > 0.96) {
      profile = "grimpeur"; profileLabel = "🏔️ Grimpeur";
      profileDesc = "Excellent rapport puissance/poids. Tu excelles en haute montagne et sur les longs cols.";
      strengths = ["Longs cols", "Haute montagne", "Granfondos avec D+"];
      weaknesses = ["Sprint final", "Terrain plat venté"];
    } else if (threshRatio > 0.96 && vo2Ratio > 1.18) {
      profile = "rouleur-grimpeur"; profileLabel = "🏔️🚴 Rouleur-Grimpeur";
      profileDesc = "Profil complet et équilibré. À l'aise sur tous les terrains, redoutable sur les granfondos.";
      strengths = ["Polyvalence", "Granfondos", "Cols modérés"];
      weaknesses = ["Sprint pur", "Très haute montagne"];
    } else {
      strengths = ["Endurance", "Régularité", "Effort long"];
      weaknesses = ["Sprint", "Efforts explosifs courts"];
    }

    // Potentiel d'amélioration
    const improvements = [];
    if (sprintRatio < 3.0) improvements.push({ zone: "Sprint (5s)", tip: "Ajoute 2×/semaine des sprints maximaux de 8-10s au sprint" });
    if (anaeRatio < 1.4) improvements.push({ zone: "Anaérobie (1min)", tip: "Séances VO2max : 6×1min à 120% FTP, récup 2min" });
    if (vo2Ratio < 1.18) improvements.push({ zone: "VO2max (5min)", tip: "Intervalles 4×4min à 110% FTP, récup 4min" });
    if (threshRatio < 0.95) improvements.push({ zone: "Seuil (20min)", tip: "2×20min à 95-100% FTP chaque semaine" });

    res.json({
      ppr: bestByDuration,
      profile: { type: profile, label: profileLabel, desc: profileDesc, strengths, weaknesses },
      improvements,
      ftp,
      weight: req.athlete.weight,
      activityCount: activities.length,
    });

  } catch(e) {
    console.error("PPR error:", e);
    res.status(500).json({ error: e.message });
  }
});
