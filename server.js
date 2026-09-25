require("dotenv").config();
require("express-async-errors");

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const PDFDocument = require("pdfkit");
const { WebSocketServer, WebSocket } = require("ws");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const app = express();
const httpServer = http.createServer(app);
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Only JPG, PNG, WEBP or PDF score sheets are allowed."), ok);
  }
});

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "blob:"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'", "wss:", "ws:"],
      "font-src": ["'self'", "data:"]
    }
  }
}));
app.use(compression());
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "change-me-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 12
  }
}));

const ROLE = {
  NCSF: "NCSF_ADMIN",
  CLUB: "CLUB_ADMIN",
  TEAM: "TEAM_ADMIN"
};

const broadcastTokens = new Map();
const liveStreams = new Map();

function issueBroadcastToken(fixtureId, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  broadcastTokens.set(token, {
    fixtureId: Number(fixtureId),
    userId: Number(userId),
    expiresAt: Date.now() + 15 * 60 * 1000
  });
  return token;
}

function consumeBroadcastToken(token, fixtureId) {
  const entry = broadcastTokens.get(String(token || ""));
  if (!entry) return null;
  broadcastTokens.delete(String(token || ""));
  if (entry.expiresAt < Date.now() || entry.fixtureId !== Number(fixtureId)) return null;
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of broadcastTokens) {
    if (entry.expiresAt < now) broadcastTokens.delete(token);
  }
}, 60 * 1000).unref();

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      short_name TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS divisions (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, name)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      division_id INTEGER REFERENCES divisions(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      short_name TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(club_id, name)
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      ncsf_number TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      suspended BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('NCSF_ADMIN','CLUB_ADMIN','TEAM_ADMIN')),
      club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fixtures (
      id SERIAL PRIMARY KEY,
      division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL DEFAULT 1,
      fixture_date TIMESTAMPTZ,
      venue TEXT,
      home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'SCHEDULED'
        CHECK (status IN ('SCHEDULED','IN_PROGRESS','SUBMITTED','CONFIRMED','APPROVED','POSTPONED','FORFEIT')),
      notes TEXT,
      submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_side TEXT CHECK (submitted_side IN ('HOME','AWAY')),
      confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      home_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      away_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      player_of_match_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      break_run_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      rack_run_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      home_captain_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      away_captain_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      bonus_points INTEGER NOT NULL DEFAULT 0,
      stream_url TEXT,
      stream_title TEXT,
      stream_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (home_team_id <> away_team_id)
    );

    CREATE TABLE IF NOT EXISTS fixture_lineups (
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('HOME','AWAY')),
      slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      PRIMARY KEY(fixture_id, side, slot),
      UNIQUE(fixture_id, side, player_id)
    );

    CREATE TABLE IF NOT EXISTS fixture_reserves (
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('HOME','AWAY')),
      reserve_slot INTEGER NOT NULL CHECK (reserve_slot BETWEEN 1 AND 2),
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      PRIMARY KEY(fixture_id, side, reserve_slot),
      UNIQUE(fixture_id, side, player_id)
    );

    CREATE TABLE IF NOT EXISTS frames (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL CHECK (round_no BETWEEN 1 AND 5),
      board_no INTEGER NOT NULL CHECK (board_no BETWEEN 1 AND 5),
      home_slot INTEGER NOT NULL CHECK (home_slot BETWEEN 1 AND 5),
      away_slot INTEGER NOT NULL CHECK (away_slot BETWEEN 1 AND 5),
      home_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      away_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      winner_side TEXT CHECK (winner_side IN ('HOME','AWAY')),
      winner_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(fixture_id, round_no, board_no)
    );

    CREATE TABLE IF NOT EXISTS substitutions (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK (side IN ('HOME','AWAY')),
      out_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      in_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
      effective_round INTEGER NOT NULL CHECK (effective_round BETWEEN 1 AND 5),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fixture_attachments (
      id SERIAL PRIMARY KEY,
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'SIGNED_SCORESHEET',
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      file_data BYTEA NOT NULL,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS live_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      display_name TEXT NOT NULL,
      role TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_live_chat_fixture_created
      ON live_chat_messages(fixture_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      fixture_id INTEGER REFERENCES fixtures(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_fixtures_division_status ON fixtures(division_id, status);
    CREATE INDEX IF NOT EXISTS idx_frames_fixture ON frames(fixture_id);
    CREATE INDEX IF NOT EXISTS idx_frames_winner ON frames(winner_player_id);
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS home_captain_id INTEGER REFERENCES players(id) ON DELETE SET NULL;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS away_captain_id INTEGER REFERENCES players(id) ON DELETE SET NULL;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS submitted_side TEXT CHECK (submitted_side IN ('HOME','AWAY'));
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS stream_url TEXT;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS stream_title TEXT;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS stream_active BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS bonus_side TEXT CHECK (bonus_side IN ('HOME','AWAY'));

    CREATE TABLE IF NOT EXISTS fixture_break_runs (
      fixture_id INTEGER NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(fixture_id, player_id)
    );
    INSERT INTO fixture_break_runs(fixture_id,player_id)
      SELECT id,break_run_player_id FROM fixtures
      WHERE break_run_player_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    UPDATE fixtures
      SET submitted_side='HOME',
          submitted_by=COALESCE(submitted_by,home_confirmed_by),
          confirmed_by=COALESCE(confirmed_by,away_confirmed_by)
      WHERE status IN ('SUBMITTED','CONFIRMED','APPROVED') AND submitted_side IS NULL;
    CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_ncsf_number_unique
      ON players(ncsf_number) WHERE ncsf_number IS NOT NULL;
    CREATE SEQUENCE IF NOT EXISTS ncsf_player_number_seq START 1;

    CREATE TABLE IF NOT EXISTS content_posts (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('NEWS','ANNOUNCEMENT','EVENT')),
      title TEXT NOT NULL,
      body TEXT,
      event_date TIMESTAMPTZ,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_posts_public
      ON content_posts(published,type,event_date,created_at);

    CREATE TABLE IF NOT EXISTS tournament_opportunities (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      discipline TEXT NOT NULL DEFAULT 'HEYBALL',
      organizer TEXT,
      location TEXT,
      start_date DATE,
      end_date DATE,
      registration_deadline DATE,
      entry_fee TEXT,
      prize_fund TEXT,
      eligibility TEXT,
      status TEXT NOT NULL DEFAULT 'COMING_SOON'
        CHECK (status IN ('OPEN','COMING_SOON','WAITLIST','INVITATION_ONLY','CLOSED')),
      description TEXT,
      registration_url TEXT,
      official_url TEXT,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tournament_opportunities_public
      ON tournament_opportunities(published,start_date,end_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_opportunities_title_unique
      ON tournament_opportunities(LOWER(title));

    INSERT INTO tournament_opportunities
      (title,discipline,organizer,location,start_date,end_date,entry_fee,prize_fund,eligibility,status,description,registration_url,official_url)
    SELECT seed.title,seed.discipline,seed.organizer,seed.location,seed.start_date::date,seed.end_date::date,
           seed.entry_fee,seed.prize_fund,seed.eligibility,seed.status,seed.description,seed.registration_url,seed.official_url
    FROM (VALUES
      ('Universal Bangkok Open 2026','9-BALL','Bangkok Cuesports Festival / World Nineball Tour','Bangkok, Thailand','2026-11-17','2026-11-21','USD 200','USD 63,000','Open application for players 16+; all genders and nationalities. Application approval is required; entry is not guaranteed.','OPEN','WNT Silver Ranking event. Submit an application and wait for confirmation from the organizer.','https://www.bangkok-cuesports.com/events/bangkok-open/register','https://www.bangkok-cuesports.com/events/bangkok-open'),
      ('Universal Bangkok Open 2026 Qualifier #5 – Pattaya','9-BALL','Bangkok Cuesports Festival / World Nineball Tour','Pattaya, Thailand','2026-09-26','2026-09-27','THB 2,000',NULL,'16+; open to all nationalities. Four qualifying spots.','OPEN','Official qualifier for the Universal Bangkok Open 2026. Registration is listed as open; confirm promptly with the organizer.','https://www.bangkok-cuesports.com/events/bangkok-open-2026-qualifier-5/register','https://www.bangkok-cuesports.com/events/bangkok-open-2026-qualifier-5'),
      ('2026 Philippines Open Pool Championship','9-BALL','World Nineball Tour','Quezon City, Philippines','2026-10-20','2026-10-24','USD 350',NULL,'Public player entry; participants must be 16 or older. Check current availability with WNT.','OPEN','Official WNT player registration page showed public entries in stock when this listing was checked.','https://worldnineballtour.com/tickets/2026-philippines-open-pool-championship-player-registration-public/','https://worldnineballtour.com/events/2026-philippines-open-pool-championship/'),
      ('Universal Open Ho Chi Minh 2026','9-BALL','World Nineball Tour','Ho Chi Minh City, Vietnam','2026-11-11','2026-11-15',NULL,'USD 63,000','Contact the WNT organizer to confirm entry requirements and availability.','COMING_SOON','Listed as a WNT ranking event; the event page directs players to contact the organizer for registration.','https://worldnineballtour.com/events/universal-open-ho-chi-minh-2026/','https://worldnineballtour.com/events/universal-open-ho-chi-minh-2026/'),
      ('Qatar World Cup 10-Ball 2026','10-BALL','World Pool Association','Qatar','2026-12-05','2026-12-14',NULL,NULL,'Player entry and federation allocation details are not published on the WPA calendar; confirm with NCSF/WPA.','COMING_SOON','Listed on the WPA calendar. Confirm entry eligibility before making travel plans.',NULL,'https://wpapool.com/calendar/')
    ) AS seed(title,discipline,organizer,location,start_date,end_date,entry_fee,prize_fund,eligibility,status,description,registration_url,official_url)
    WHERE NOT EXISTS (
      SELECT 1 FROM tournament_opportunities existing
      WHERE LOWER(existing.title)=LOWER(seed.title)
    )
    ON CONFLICT DO NOTHING;
  `);
}


async function seedOfficialCoastalRosters() {
  const migrationKey = "official-coastal-rosters-2026-09-22-v1";

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [migrationKey]);
  if (already.rowCount) return;

  const rosters = [
    {
      club: "007-Coastal",
      team: "007-Coastal",
      players: [
        ["Bertram", "", "0401-0420"],
        ["Aschlin", "", "0441-0460"],
        ["Omar", "", "0461-0480"],
        ["Shaun", "", "0481-0500"],
        ["Ethan", "", "0501-0520"],
        ["Justin", "", "0421-0440"],
        ["Jaques", "", "0521-0540"],
        ["Phillip", "", "0541-0560"],
        ["Bernardus", "", "0561-0580"]
      ]
    },
    {
      club: "Atomic 5",
      team: "Atomic 5",
      players: [
        ["Waquar", "Satar", null],
        ["Robert", "Erasmus", null],
        ["Warren", "Smith", null],
        ["Brian", "Anderson", null],
        ["Lee-Heino", "van Rooi", null],
        ["Daniel", "Jacobs", null],
        ["Abisai", "Kuutondokwa", null],
        ["Silence", "Chiradza", null]
      ]
    },
    {
      club: "Coastal Warriors",
      team: "Coastal Suns",
      players: [
        ["Connery", "Pienaar", null],
        ["Jaden", "Jeffery", null],
        ["Reginald", "van Wyk", null],
        ["D’Lano", "van Wyk", null],
        ["Matheus", "Onesmus", null],
        ["Leon", "Beukes", null],
        ["Rudolf", "Koopman", null],
        ["Ronaldo", "Koopman", null],
        ["Thisbe", "Murorua", null],
        ["Thimoteus", "Heelu", null],
        ["Tangeni", "Johannes", null]
      ]
    },
    {
      club: "Coastal Warriors",
      team: "Coastal Waves",
      players: [
        ["Clavin", "Mbawa", null],
        ["Fillipus", "Wakanbalala", null],
        ["Jason", "Shimbango", null],
        ["Likeus", "Nauyoma", null],
        ["Wilhelm", "Katana", null],
        ["Augustineus", "Endjala", null],
        ["Pombili", "Kahenge", null],
        ["Joey", "Rickets", null],
        ["Nikanor", "Shiteni", null],
        ["Reinhold", "Ipinge", null],
        ["Johannes", "Shipundi", null],
        ["Kennedy", "Kasenda", null]
      ]
    },
    {
      club: "Celtic",
      team: "Celtic",
      players: [
        ["Anton", "Strauss", null],
        ["Cyril", "Möller", null],
        ["Collin", "Bougardt", null],
        ["Afrika", "Kuhatunwa", null],
        ["Leon", "Kolz", null],
        ["Andreas", "Hauwanga", null],
        ["Kennedy", "Enkali", null],
        ["Cyril", "Möller (Jnr)", null],
        ["Ruzaan", "Möller", null],
        ["Jean-Piere", "Pietersen", null],
        ["Justin", "Kolz", null],
        ["Izaan", "Möller", null]
      ]
    },
    {
      club: "West Coast",
      team: "West Coast",
      players: [
        ["Aldo", "Loxton", null],
        ["Juandro", "van Rooi", null],
        ["Elrizza", "Koopman", null],
        ["Vivian", "Koopman", null],
        ["Ashwan", "Loxton", null],
        ["Christeline", "de Klerk", null],
        ["Franklin", "Visagie", null],
        ["Lemar", "van Rooyen", null]
      ]
    },
    {
      club: "Sparta",
      team: "Sparta",
      players: [
        ["Romario", "Schwartz", null],
        ["John", "Claasen", null],
        ["Tyrone", "Vogel", null],
        ["Dudley", "Smith", null],
        ["David", "van Neel", null],
        ["Daniel", "Clark", null],
        ["Iwanne", "Isaacs", null],
        ["Bernward", "Diergaardt", null]
      ]
    }
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM users WHERE role <> 'NCSF_ADMIN'");
    await client.query("DELETE FROM fixtures");
    await client.query("DELETE FROM players");
    await client.query("DELETE FROM teams");
    await client.query("DELETE FROM clubs");

    let divisionId = null;
    const existingDivision = await client.query(`
      SELECT id FROM divisions
      WHERE active=TRUE
      ORDER BY sort_order, id
      LIMIT 1
    `);
    if (existingDivision.rowCount) {
      divisionId = existingDivision.rows[0].id;
    } else {
      let seasonId = null;
      const existingSeason = await client.query(`
        SELECT id FROM seasons
        ORDER BY active DESC, id
        LIMIT 1
      `);
      if (existingSeason.rowCount) {
        seasonId = existingSeason.rows[0].id;
      } else {
        const season = await client.query(`
          INSERT INTO seasons(name,start_date,active)
          VALUES ('2026 NCSF Season', CURRENT_DATE, TRUE)
          RETURNING id
        `);
        seasonId = season.rows[0].id;
      }
      const division = await client.query(`
        INSERT INTO divisions(season_id,name,sort_order,active)
        VALUES ($1,'League Division',1,TRUE)
        RETURNING id
      `, [seasonId]);
      divisionId = division.rows[0].id;
    }

    const clubIds = new Map();
    for (const roster of rosters) {
      let clubId = clubIds.get(roster.club);
      if (!clubId) {
        const club = await client.query(
          "INSERT INTO clubs(name,short_name,active) VALUES ($1,$2,TRUE) RETURNING id",
          [roster.club, roster.club]
        );
        clubId = club.rows[0].id;
        clubIds.set(roster.club, clubId);
      }

      const team = await client.query(
        "INSERT INTO teams(club_id,division_id,name,short_name,active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id",
        [clubId, divisionId, roster.team, roster.team]
      );
      const teamId = team.rows[0].id;

      for (const [firstName, lastName, ncsfNumber] of roster.players) {
        await client.query(`
          INSERT INTO players(club_id,team_id,ncsf_number,first_name,last_name,active,suspended)
          VALUES ($1,$2,$3,$4,$5,TRUE,FALSE)
        `, [clubId, teamId, ncsfNumber, firstName, lastName]);
      }
    }

    await client.query("INSERT INTO app_migrations(key) VALUES ($1)", [migrationKey]);
    await client.query("COMMIT");
    console.log("Applied official Coastal league club/team/player roster import.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function generateNcsfNumber(db = pool) {
  const { rows } = await db.query("SELECT nextval('ncsf_player_number_seq')::bigint AS n");
  return "NCSF-" + String(rows[0].n).padStart(4, "0");
}

async function assignOfficialNcsfNumbers() {
  const migrationKey = "assign-individual-ncsf-numbers-2026-09-22-v1";
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [migrationKey]);
  if (already.rowCount) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: players } = await client.query(`
      SELECT p.id
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      LEFT JOIN clubs c ON c.id=p.club_id
      ORDER BY COALESCE(c.name,''), COALESCE(t.name,''), p.last_name, p.first_name, p.id
    `);
    let n = 0;
    for (const player of players) {
      n += 1;
      const number = "NCSF-" + String(n).padStart(4, "0");
      await client.query("UPDATE players SET ncsf_number=$2 WHERE id=$1", [player.id, number]);
    }
    await client.query("SELECT setval('ncsf_player_number_seq', $1, true)", [Math.max(n, 1)]);
    await client.query("INSERT INTO app_migrations(key) VALUES($1)", [migrationKey]);
    await client.query("COMMIT");
    console.log("Assigned individual NCSF numbers to all registered players.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


async function setupCentralDivisionAndSchedule() {
  const migrationKey = "central-division-fixtures-events-2026-09-22-v1";
  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [migrationKey]);
  if (already.rowCount) return;

  const centralTeams = ["RPC","Pocket Kings NA","Precision 7","007 - Central","Ofifiya PC","Queen Cues","Namshooters","Tura Boys","Cue Crew","Cattle Country","Joga Bonita","YOPC 2","Rack Royalty","Blackball Bandits","YOPC 1","Pool Pirates"];
  const coastalTeams = ["007-Coastal","Atomic 5","Coastal Suns","Coastal Waves","Celtic","West Coast","Sparta"];
  const fixtures = [
    ["2026-09-26T10:30:00+02:00","Cattle Country","YOPC 1",1],
    ["2026-09-26T10:30:00+02:00","Namshooters","Blackball Bandits",1],
    ["2026-09-26T10:30:00+02:00","Pocket Kings NA","Pool Pirates",1],
    ["2026-09-26T10:30:00+02:00","Tura Boys","Queen Cues",1],
    ["2026-09-26T10:30:00+02:00","RPC","Rack Royalty",1],
    ["2026-09-26T10:30:00+02:00","Cue Crew","007 - Central",1],
    ["2026-09-26T10:30:00+02:00","Ofifiya PC","Joga Bonita",1],
    ["2026-09-26T15:00:00+02:00","Cattle Country","YOPC 2",1],
    ["2026-09-26T15:00:00+02:00","Namshooters","Pool Pirates",1],
    ["2026-09-26T15:00:00+02:00","Pocket Kings NA","Blackball Bandits",1],
    ["2026-09-26T15:00:00+02:00","Tura Boys","Joga Bonita",1],
    ["2026-09-26T15:00:00+02:00","Precision 7","Rack Royalty",1],
    ["2026-09-26T15:00:00+02:00","Queen Cues","007 - Central",1],
    ["2026-10-03T10:30:00+02:00","RPC","Pocket Kings NA",2],
    ["2026-10-03T10:30:00+02:00","Precision 7","007 - Central",2],
    ["2026-10-03T10:30:00+02:00","Ofifiya PC","Queen Cues",2],
    ["2026-10-03T10:30:00+02:00","Cue Crew","Cattle Country",2],
    ["2026-10-03T10:30:00+02:00","Joga Bonita","YOPC 2",2],
    ["2026-10-03T10:30:00+02:00","Tura Boys","Rack Royalty",2],
    ["2026-10-03T15:00:00+02:00","Precision 7","Pocket Kings NA",2],
    ["2026-10-03T15:00:00+02:00","RPC","007 - Central",2],
    ["2026-10-03T15:00:00+02:00","Namshooters","Tura Boys",2],
    ["2026-10-03T15:00:00+02:00","Ofifiya PC","Cattle Country",2],
    ["2026-10-03T15:00:00+02:00","Rack Royalty","Blackball Bandits",2],
    ["2026-10-03T15:00:00+02:00","YOPC 2","Cue Crew",2]
  ];
  const events = [
    ["Top 8 Play-offs — Central Zone","Top 8 play-offs for the Central Zone.","2026-10-17T11:00:00+02:00",true],
    ["NBBL League Quarter Finals","Quarter finals from the official NBBL league calendar.","2026-10-31T10:30:00+02:00",false],
    ["NBBL League Semi Finals","Semi finals from the official NBBL league calendar.","2026-10-31T15:00:00+02:00",false],
    ["NCSF AGM","Annual General Meeting.","2026-11-14T08:00:00+02:00",true],
    ["NBBL League Finals","Finals from the official NBBL league calendar.","2026-11-14T15:00:00+02:00",true],
    ["Namibia Champ of Champs","Namibia Champion of Champions event.","2026-11-27T08:00:00+02:00",true]
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const seasonResult = await client.query("SELECT id FROM seasons ORDER BY active DESC, start_date DESC NULLS LAST, id DESC LIMIT 1");
    if (!seasonResult.rowCount) throw new Error("Create a season before importing Central Division.");
    const seasonId = seasonResult.rows[0].id;

    let coastalDivisionId = null;
    let d = await client.query("SELECT id FROM divisions WHERE season_id=$1 AND LOWER(name)='coastal' LIMIT 1", [seasonId]);
    if (d.rowCount) {
      coastalDivisionId = d.rows[0].id;
    } else {
      d = await client.query("SELECT division_id id FROM teams WHERE name='Coastal Waves' AND division_id IS NOT NULL LIMIT 1");
      if (d.rowCount) {
        coastalDivisionId = d.rows[0].id;
        await client.query("UPDATE divisions SET name='Coastal',sort_order=1 WHERE id=$1", [coastalDivisionId]);
      } else {
        d = await client.query("INSERT INTO divisions(season_id,name,sort_order,active) VALUES($1,'Coastal',1,TRUE) RETURNING id", [seasonId]);
        coastalDivisionId = d.rows[0].id;
      }
    }
    await client.query("UPDATE teams SET division_id=$1 WHERE name=ANY($2::text[])", [coastalDivisionId, coastalTeams]);

    let centralDivisionId = null;
    d = await client.query("SELECT id FROM divisions WHERE season_id=$1 AND LOWER(name)='central' LIMIT 1", [seasonId]);
    if (d.rowCount) {
      centralDivisionId = d.rows[0].id;
      await client.query("UPDATE divisions SET active=TRUE,sort_order=2 WHERE id=$1", [centralDivisionId]);
    } else {
      d = await client.query("INSERT INTO divisions(season_id,name,sort_order,active) VALUES($1,'Central',2,TRUE) RETURNING id", [seasonId]);
      centralDivisionId = d.rows[0].id;
    }

    const teamIds = new Map();
    for (const teamName of centralTeams) {
      let q = await client.query("SELECT id FROM clubs WHERE name=$1 LIMIT 1", [teamName]);
      let clubId;
      if (q.rowCount) clubId = q.rows[0].id;
      else {
        q = await client.query("INSERT INTO clubs(name,short_name,active) VALUES($1,$1,TRUE) RETURNING id", [teamName]);
        clubId = q.rows[0].id;
      }

      q = await client.query("SELECT id FROM teams WHERE club_id=$1 AND name=$2 LIMIT 1", [clubId, teamName]);
      let teamId;
      if (q.rowCount) {
        teamId = q.rows[0].id;
        await client.query("UPDATE teams SET division_id=$2,active=TRUE WHERE id=$1", [teamId, centralDivisionId]);
      } else {
        q = await client.query("INSERT INTO teams(club_id,division_id,name,short_name,active) VALUES($1,$2,$3,$3,TRUE) RETURNING id", [clubId, centralDivisionId, teamName]);
        teamId = q.rows[0].id;
      }
      teamIds.set(teamName, teamId);
    }

    for (const item of fixtures) {
      const date=item[0], homeName=item[1], awayName=item[2], roundNo=item[3];
      const homeId=teamIds.get(homeName), awayId=teamIds.get(awayName);
      const q = await client.query("SELECT id FROM fixtures WHERE division_id=$1 AND home_team_id=$2 AND away_team_id=$3 AND fixture_date=$4::timestamptz LIMIT 1", [centralDivisionId,homeId,awayId,date]);
      if (!q.rowCount) await client.query("INSERT INTO fixtures(division_id,round_no,fixture_date,home_team_id,away_team_id,status) VALUES($1,$2,$3::timestamptz,$4,$5,'SCHEDULED')", [centralDivisionId,roundNo,date,homeId,awayId]);
    }

    for (const item of events) {
      const title=item[0], body=item[1], eventDate=item[2], pinned=item[3];
      const q = await client.query("SELECT id FROM content_posts WHERE type='EVENT' AND title=$1 AND event_date=$2::timestamptz LIMIT 1", [title,eventDate]);
      if (!q.rowCount) await client.query("INSERT INTO content_posts(type,title,body,event_date,published,pinned) VALUES('EVENT',$1,$2,$3::timestamptz,TRUE,$4)", [title,body,eventDate,pinned]);
    }
    const note = await client.query("SELECT id FROM content_posts WHERE type='ANNOUNCEMENT' AND title='Central Division remaining fixtures published' LIMIT 1");
    if (!note.rowCount) await client.query("INSERT INTO content_posts(type,title,body,published,pinned) VALUES('ANNOUNCEMENT','Central Division remaining fixtures published','The Central Division fixtures for 26 September and 3 October 2026 are now available in the NCSF League Manager.',TRUE,TRUE)");

    await client.query("INSERT INTO app_migrations(key) VALUES($1)", [migrationKey]);
    await client.query("COMMIT");
    console.log("Configured Coastal/Central divisions and imported remaining Central fixtures/events.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


async function correctAtomic5AndImportCoastalSchedule() {
  const migrationKey = "coastal-atomic5-remaining-fixtures-2026-09-22-v1";
  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [migrationKey]);
  if (already.rowCount) return;

  const fixtures = [
    ["2026-09-25T18:30:00+02:00","West Coast","Sparta",1],

    ["2026-09-26T10:30:00+02:00","West Coast","Celtic",1],
    ["2026-09-26T10:30:00+02:00","007-Coastal","Coastal Waves",1],
    ["2026-09-26T10:30:00+02:00","Coastal Suns","Atomic 5",1],
    ["2026-09-26T15:00:00+02:00","Coastal Waves","Celtic",1],
    ["2026-09-26T15:00:00+02:00","007-Coastal","West Coast",1],

    ["2026-10-09T18:30:00+02:00","Sparta","Celtic",2],

    ["2026-10-10T10:30:00+02:00","Coastal Suns","Celtic",2],
    ["2026-10-10T10:30:00+02:00","Sparta","Coastal Waves",2],
    ["2026-10-10T10:30:00+02:00","Atomic 5","007-Coastal",2],
    ["2026-10-10T15:00:00+02:00","Coastal Suns","West Coast",2],
    ["2026-10-10T15:00:00+02:00","Atomic 5","Coastal Waves",2],
    ["2026-10-10T15:00:00+02:00","Sparta","007-Coastal",2]
  ];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const seasonResult = await client.query(
      "SELECT id FROM seasons ORDER BY active DESC, start_date DESC NULLS LAST, id DESC LIMIT 1"
    );
    if (!seasonResult.rowCount) throw new Error("Create a season before importing Coastal fixtures.");
    const seasonId = seasonResult.rows[0].id;

    let divisionResult = await client.query(
      "SELECT id FROM divisions WHERE season_id=$1 AND LOWER(name)='coastal' LIMIT 1",
      [seasonId]
    );
    if (!divisionResult.rowCount) {
      divisionResult = await client.query(
        "INSERT INTO divisions(season_id,name,sort_order,active) VALUES($1,'Coastal',1,TRUE) RETURNING id",
        [seasonId]
      );
    }
    const coastalDivisionId = divisionResult.rows[0].id;

    let atomicClub = await client.query("SELECT id FROM clubs WHERE name='Atomic 5' LIMIT 1");
    let atomicClubId;
    if (atomicClub.rowCount) {
      atomicClubId = atomicClub.rows[0].id;
    } else {
      atomicClub = await client.query(
        "INSERT INTO clubs(name,short_name,active) VALUES('Atomic 5','Atomic 5',TRUE) RETURNING id"
      );
      atomicClubId = atomicClub.rows[0].id;
    }

    const oldAtomicTeam = await client.query(
      "SELECT id FROM teams WHERE name='Coastal Warriors' LIMIT 1"
    );
    if (oldAtomicTeam.rowCount) {
      const teamId = oldAtomicTeam.rows[0].id;
      await client.query(
        "UPDATE teams SET name='Atomic 5',short_name='Atomic 5',club_id=$2,division_id=$3,active=TRUE WHERE id=$1",
        [teamId, atomicClubId, coastalDivisionId]
      );
      await client.query(
        "UPDATE players SET club_id=$2 WHERE team_id=$1",
        [teamId, atomicClubId]
      );
      await client.query(
        "UPDATE users SET club_id=$2 WHERE team_id=$1",
        [teamId, atomicClubId]
      );
    }

    const atomicTeam = await client.query(
      "SELECT id FROM teams WHERE name='Atomic 5' LIMIT 1"
    );
    if (!atomicTeam.rowCount) throw new Error("Atomic 5 team could not be resolved.");
    await client.query(
      "UPDATE teams SET club_id=$2,division_id=$3,active=TRUE WHERE id=$1",
      [atomicTeam.rows[0].id, atomicClubId, coastalDivisionId]
    );
    await client.query(
      "UPDATE players SET club_id=$2 WHERE team_id=$1",
      [atomicTeam.rows[0].id, atomicClubId]
    );

    const teamNames = ["007-Coastal","Atomic 5","Coastal Suns","Coastal Waves","Celtic","West Coast","Sparta"];
    await client.query(
      "UPDATE teams SET division_id=$1 WHERE name=ANY($2::text[])",
      [coastalDivisionId, teamNames]
    );

    const teamRows = await client.query(
      "SELECT id,name FROM teams WHERE name=ANY($1::text[])",
      [teamNames]
    );
    const teamIds = new Map(teamRows.rows.map(r => [r.name, r.id]));
    for (const name of teamNames) {
      if (!teamIds.get(name)) throw new Error("Missing Coastal team: " + name);
    }

    for (const item of fixtures) {
      const date=item[0], homeName=item[1], awayName=item[2], roundNo=item[3];
      const homeId=teamIds.get(homeName), awayId=teamIds.get(awayName);
      const existing = await client.query(
        "SELECT id FROM fixtures WHERE division_id=$1 AND home_team_id=$2 AND away_team_id=$3 AND fixture_date=$4::timestamptz LIMIT 1",
        [coastalDivisionId,homeId,awayId,date]
      );
      if (!existing.rowCount) {
        await client.query(
          "INSERT INTO fixtures(division_id,round_no,fixture_date,home_team_id,away_team_id,status) VALUES($1,$2,$3::timestamptz,$4,$5,'SCHEDULED')",
          [coastalDivisionId,roundNo,date,homeId,awayId]
        );
      }
    }

    // The Coastal schedule shows the national Champ of Champs at 08:00.
    await client.query(
      "UPDATE content_posts SET event_date='2026-11-27T08:00:00+02:00'::timestamptz,updated_at=NOW() WHERE type='EVENT' AND title='Namibia Champ of Champs'"
    );

    const note = await client.query(
      "SELECT id FROM content_posts WHERE type='ANNOUNCEMENT' AND title='Coastal Division remaining fixtures published' LIMIT 1"
    );
    if (!note.rowCount) {
      await client.query(
        "INSERT INTO content_posts(type,title,body,published,pinned) VALUES('ANNOUNCEMENT','Coastal Division remaining fixtures published','The remaining Coastal Division fixtures for 25–26 September and 9–10 October 2026 are now available in the NCSF League Manager.',TRUE,TRUE)"
      );
    }

    await client.query("INSERT INTO app_migrations(key) VALUES($1)", [migrationKey]);
    await client.query("COMMIT");
    console.log("Corrected Atomic 5 roster and imported remaining Coastal fixtures.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    clubId: row.club_id,
    teamId: row.team_id,
    clubName: row.club_name || null,
    teamName: row.team_name || null
  };
}

async function currentUserById(id) {
  const { rows } = await pool.query(`
    SELECT u.*, c.name club_name, t.name team_name
    FROM users u
    LEFT JOIN clubs c ON c.id=u.club_id
    LEFT JOIN teams t ON t.id=u.team_id
    WHERE u.id=$1 AND u.active=TRUE
  `, [id]);
  return rows[0] || null;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please sign in." });
  next();
}

function requireRoles(...roles) {
  return async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: "Please sign in." });
    const user = await currentUserById(req.session.userId);
    if (!user || !roles.includes(user.role)) return res.status(403).json({ error: "You do not have access to this area." });
    req.user = user;
    next();
  };
}

async function audit(userId, fixtureId, action, detail = {}) {
  await pool.query(
    "INSERT INTO audit_logs(user_id, fixture_id, action, detail) VALUES($1,$2,$3,$4)",
    [userId || null, fixtureId || null, action, JSON.stringify(detail)]
  );
}

async function fixtureById(id) {
  const { rows } = await pool.query(`
    SELECT f.*, d.name division_name, s.name season_name,
           ht.name home_team_name, at.name away_team_name,
           hc.name home_club_name, ac.name away_club_name,
           ht.club_id home_club_id, at.club_id away_club_id
    FROM fixtures f
    JOIN divisions d ON d.id=f.division_id
    JOIN seasons s ON s.id=d.season_id
    JOIN teams ht ON ht.id=f.home_team_id
    JOIN teams at ON at.id=f.away_team_id
    JOIN clubs hc ON hc.id=ht.club_id
    JOIN clubs ac ON ac.id=at.club_id
    WHERE f.id=$1
  `, [id]);
  return rows[0] || null;
}

function canManageFixture(user, fixture) {
  if (!user || !fixture) return false;
  if (user.role === ROLE.NCSF) return true;
  if (user.role === ROLE.CLUB) {
    return user.club_id === fixture.home_club_id || user.club_id === fixture.away_club_id;
  }
  if (user.role === ROLE.TEAM) {
    return user.team_id === fixture.home_team_id || user.team_id === fixture.away_team_id;
  }
  return false;
}

function sideForUser(user, fixture) {
  if (!user || !fixture) return null;
  if (user.role === ROLE.NCSF) return "NCSF";
  if (user.role === ROLE.TEAM) {
    if (user.team_id === fixture.home_team_id) return "HOME";
    if (user.team_id === fixture.away_team_id) return "AWAY";
  }
  if (user.role === ROLE.CLUB) {
    if (user.club_id === fixture.home_club_id) return "HOME";
    if (user.club_id === fixture.away_club_id) return "AWAY";
  }
  return null;
}

async function teamBelongsToClub(teamId, clubId) {
  const { rowCount } = await pool.query("SELECT 1 FROM teams WHERE id=$1 AND club_id=$2", [teamId, clubId]);
  return rowCount > 0;
}

const MATCH_BREAK_SEQUENCE = [
  { side: "HOME", slot: 1, label: "1" },
  { side: "AWAY", slot: 2, label: "B" },
  { side: "HOME", slot: 3, label: "3" },
  { side: "AWAY", slot: 4, label: "D" },
  { side: "HOME", slot: 5, label: "5" },
  { side: "AWAY", slot: 1, label: "A" },
  { side: "HOME", slot: 2, label: "2" },
  { side: "AWAY", slot: 3, label: "C" },
  { side: "HOME", slot: 4, label: "4" },
  { side: "AWAY", slot: 5, label: "E" }
];

function assignBreakOrder(frames) {
  for (const frame of frames) {
    const index = ((Number(frame.round_no) - 1) * 5) + Number(frame.board_no) - 1;
    const assignment = MATCH_BREAK_SEQUENCE[((index % MATCH_BREAK_SEQUENCE.length) + MATCH_BREAK_SEQUENCE.length) % MATCH_BREAK_SEQUENCE.length];
    frame.break_side = assignment.side;
    frame.break_slot = assignment.slot;
    frame.break_label = assignment.label;
  }
}

async function ensureFrames(fixtureId) {
  const { rows: lineups } = await pool.query(
    "SELECT side, slot, player_id FROM fixture_lineups WHERE fixture_id=$1 ORDER BY side, slot",
    [fixtureId]
  );
  const home = new Map(lineups.filter(x => x.side === "HOME").map(x => [x.slot, x.player_id]));
  const away = new Map(lineups.filter(x => x.side === "AWAY").map(x => [x.slot, x.player_id]));
  if (home.size !== 5 || away.size !== 5) return false;

  const shifts = [0, 2, 4, 1, 3];
  for (let round = 1; round <= 5; round++) {
    const shift = shifts[round - 1];
    for (let board = 1; board <= 5; board++) {
      const homeSlot = board;
      const awaySlot = ((board - 1 + shift) % 5) + 1;
      await pool.query(`
        INSERT INTO frames(fixture_id, round_no, board_no, home_slot, away_slot, home_player_id, away_player_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(fixture_id, round_no, board_no) DO UPDATE SET
          home_slot=EXCLUDED.home_slot,
          away_slot=EXCLUDED.away_slot,
          home_player_id=EXCLUDED.home_player_id,
          away_player_id=EXCLUDED.away_player_id
        WHERE frames.winner_side IS NULL
      `, [fixtureId, round, board, homeSlot, awaySlot, home.get(homeSlot), away.get(awaySlot)]);
    }
  }
  return true;
}

async function syncDerivedFixtureExtras(fixtureId) {
  const { rows } = await pool.query(`
    SELECT winner_side,winner_player_id
    FROM frames
    WHERE fixture_id=$1 AND winner_side IS NOT NULL
  `, [fixtureId]);

  let home = 0;
  let away = 0;
  const wins = new Map();

  for (const row of rows) {
    if (row.winner_side === "HOME") home++;
    if (row.winner_side === "AWAY") away++;
    if (row.winner_player_id) {
      const id = Number(row.winner_player_id);
      wins.set(id, (wins.get(id) || 0) + 1);
    }
  }

  const maxWins = wins.size ? Math.max(...wins.values()) : 0;
  const playerOfMatchIds = maxWins > 0
    ? [...wins.entries()]
        .filter(([,count]) => count === maxWins)
        .map(([id]) => Number(id))
        .sort((a,b) => a - b)
    : [];

  let bonusSide = null;
  if (home >= 18) bonusSide = "HOME";
  else if (away >= 18) bonusSide = "AWAY";

  await pool.query(`
    UPDATE fixtures
       SET player_of_match_id=$2,
           bonus_points=$3,
           bonus_side=$4
     WHERE id=$1
  `, [
    fixtureId,
    playerOfMatchIds[0] || null,
    bonusSide ? 1 : 0,
    bonusSide
  ]);

  return { home, away, maxWins, playerOfMatchIds, bonusSide, bonusPoints: bonusSide ? 1 : 0 };
}

async function getStandings(divisionId) {
  const { rows } = await pool.query(`
    WITH match_scores AS (
      SELECT f.id, f.home_team_id, f.away_team_id,
             COUNT(*) FILTER (WHERE fr.winner_side='HOME')::int home_frames,
             COUNT(*) FILTER (WHERE fr.winner_side='AWAY')::int away_frames
      FROM fixtures f
      JOIN frames fr ON fr.fixture_id=f.id
      WHERE f.division_id=$1 AND f.status='APPROVED'
      GROUP BY f.id
    ),
    team_rows AS (
      SELECT home_team_id team_id, home_frames frames_for, away_frames frames_against,
             CASE WHEN home_frames>away_frames THEN 1 ELSE 0 END wins,
             CASE WHEN home_frames<away_frames THEN 1 ELSE 0 END losses
      FROM match_scores
      UNION ALL
      SELECT away_team_id team_id, away_frames frames_for, home_frames frames_against,
             CASE WHEN away_frames>home_frames THEN 1 ELSE 0 END wins,
             CASE WHEN away_frames<home_frames THEN 1 ELSE 0 END losses
      FROM match_scores
    )
    SELECT t.id team_id, t.name team_name, c.name club_name,
           COUNT(tr.team_id)::int played,
           COALESCE(SUM(tr.wins),0)::int wins,
           COALESCE(SUM(tr.losses),0)::int losses,
           COALESCE(SUM(tr.frames_for),0)::int frames_won,
           COALESCE(SUM(tr.frames_against),0)::int frames_lost,
           COALESCE(SUM(tr.frames_for-tr.frames_against),0)::int frame_difference
    FROM teams t
    JOIN clubs c ON c.id=t.club_id
    LEFT JOIN team_rows tr ON tr.team_id=t.id
    WHERE t.division_id=$1 AND t.active=TRUE
    GROUP BY t.id,c.name
    ORDER BY frames_won DESC, frame_difference DESC, wins DESC, team_name ASC
  `, [divisionId]);
  return rows;
}

async function getIndividualRankings(divisionId) {
  const { rows } = await pool.query(`
    SELECT p.id player_id,
           p.first_name || ' ' || p.last_name player_name,
           p.ncsf_number,
           t.name team_name,
           c.name club_name,
           COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL)::int frames_played,
           COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL AND fr.winner_player_id=p.id)::int frames_won,
           COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL AND fr.winner_player_id IS NOT NULL AND fr.winner_player_id<>p.id)::int frames_lost,
           CASE WHEN COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL)=0 THEN 0
                ELSE ROUND((COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL AND fr.winner_player_id=p.id)::numeric / NULLIF(COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL),0)::numeric) * 100, 1)
           END win_percentage
    FROM players p
    JOIN teams t ON t.id=p.team_id
    JOIN clubs c ON c.id=p.club_id
    LEFT JOIN frames fr ON (fr.home_player_id=p.id OR fr.away_player_id=p.id)
    LEFT JOIN fixtures f ON f.id=fr.fixture_id AND f.status='APPROVED' AND f.division_id=$1
    WHERE t.division_id=$1 AND p.active=TRUE
    GROUP BY p.id,t.name,c.name
    HAVING COUNT(f.id) > 0
    ORDER BY frames_won DESC, win_percentage DESC, frames_played DESC, player_name ASC
  `, [divisionId]);
  return rows;
}

async function fixturePayload(fixture) {
  const [{ rows: lineups }, { rows: reserves }, { rows: frames }, { rows: subs }, { rows: attachments }, { rows: breakRuns }] = await Promise.all([
    pool.query(`
      SELECT fl.side, fl.slot, p.id player_id, p.first_name, p.last_name, p.ncsf_number
      FROM fixture_lineups fl
      JOIN players p ON p.id=fl.player_id
      WHERE fl.fixture_id=$1
      ORDER BY fl.side, fl.slot
    `, [fixture.id]),
    pool.query(`
      SELECT r.side, r.reserve_slot, p.id player_id, p.first_name, p.last_name, p.ncsf_number
      FROM fixture_reserves r
      JOIN players p ON p.id=r.player_id
      WHERE r.fixture_id=$1
      ORDER BY r.side, r.reserve_slot
    `, [fixture.id]),
    pool.query(`
      SELECT fr.*,
             hp.first_name || ' ' || hp.last_name home_player_name,
             ap.first_name || ' ' || ap.last_name away_player_name
      FROM frames fr
      JOIN players hp ON hp.id=fr.home_player_id
      JOIN players ap ON ap.id=fr.away_player_id
      WHERE fr.fixture_id=$1
      ORDER BY fr.round_no, fr.board_no
    `, [fixture.id]),
    pool.query(`
      SELECT s.*, op.first_name || ' ' || op.last_name out_player_name,
             ip.first_name || ' ' || ip.last_name in_player_name
      FROM substitutions s
      JOIN players op ON op.id=s.out_player_id
      JOIN players ip ON ip.id=s.in_player_id
      WHERE s.fixture_id=$1
      ORDER BY s.created_at
    `, [fixture.id]),
    pool.query(`
      SELECT id, kind, filename, mimetype, created_at
      FROM fixture_attachments
      WHERE fixture_id=$1
      ORDER BY created_at DESC
    `, [fixture.id]),
    pool.query(`
      SELECT br.player_id,p.first_name,p.last_name,p.ncsf_number
      FROM fixture_break_runs br
      JOIN players p ON p.id=br.player_id
      WHERE br.fixture_id=$1
      ORDER BY p.last_name,p.first_name,p.id
    `, [fixture.id])
  ]);

  assignBreakOrder(frames);

  const scored = frames.filter(f => f.winner_side);
  const homeFrames = scored.filter(f => f.winner_side === "HOME").length;
  const awayFrames = scored.filter(f => f.winner_side === "AWAY").length;

  const winCounts = new Map();
  for (const fr of scored) {
    if (!fr.winner_player_id) continue;
    const id = Number(fr.winner_player_id);
    winCounts.set(id, (winCounts.get(id) || 0) + 1);
  }
  const maxPlayerWins = winCounts.size ? Math.max(...winCounts.values()) : 0;
  const playerOfMatchIds = maxPlayerWins > 0
    ? [...winCounts.entries()]
        .filter(([,count]) => count === maxPlayerWins)
        .map(([id]) => Number(id))
        .sort((a,b) => a - b)
    : [];
  const bonusSide = homeFrames >= 18 ? "HOME" : awayFrames >= 18 ? "AWAY" : null;
  const bonusPoints = bonusSide ? 1 : 0;

  // Keep legacy single-value fixture columns synchronized for compatibility.
  if (
    Number(fixture.player_of_match_id || 0) !== Number(playerOfMatchIds[0] || 0) ||
    Number(fixture.bonus_points || 0) !== bonusPoints ||
    (fixture.bonus_side || null) !== bonusSide
  ) {
    await pool.query(
      "UPDATE fixtures SET player_of_match_id=$2,bonus_points=$3,bonus_side=$4 WHERE id=$1",
      [fixture.id, playerOfMatchIds[0] || null, bonusPoints, bonusSide]
    );
  }

  return {
    fixture: {
      id: fixture.id,
      divisionId: fixture.division_id,
      divisionName: fixture.division_name,
      seasonName: fixture.season_name,
      roundNo: fixture.round_no,
      fixtureDate: fixture.fixture_date,
      venue: fixture.venue,
      homeTeamId: fixture.home_team_id,
      awayTeamId: fixture.away_team_id,
      homeTeamName: fixture.home_team_name,
      awayTeamName: fixture.away_team_name,
      homeClubName: fixture.home_club_name,
      awayClubName: fixture.away_club_name,
      homeClubId: fixture.home_club_id,
      awayClubId: fixture.away_club_id,
      status: fixture.status,
      notes: fixture.notes,
      submittedSide: fixture.submitted_side,
      submittedBy: fixture.submitted_by,
      confirmedBy: fixture.confirmed_by,
      homeConfirmed: Boolean(fixture.home_confirmed_by),
      awayConfirmed: Boolean(fixture.away_confirmed_by),
      approvedAt: fixture.approved_at,
      playerOfMatchId: playerOfMatchIds[0] || null,
      playerOfMatchIds,
      playerOfMatchMaxWins: maxPlayerWins,
      breakRunPlayerId: breakRuns[0]?.player_id || fixture.break_run_player_id || null,
      breakRunPlayerIds: breakRuns.map(r => Number(r.player_id)),
      breakRunPlayers: breakRuns.map(r => ({
        playerId: Number(r.player_id),
        firstName: r.first_name,
        lastName: r.last_name,
        ncsfNumber: r.ncsf_number
      })),
      rackRunPlayerId: fixture.rack_run_player_id,
      homeCaptainId: fixture.home_captain_id,
      awayCaptainId: fixture.away_captain_id,
      bonusPoints,
      bonusSide,
      bonusTeamId: bonusSide === "HOME" ? fixture.home_team_id : bonusSide === "AWAY" ? fixture.away_team_id : null,
      bonusTeamName: bonusSide === "HOME" ? fixture.home_team_name : bonusSide === "AWAY" ? fixture.away_team_name : null,
      streamUrl: fixture.stream_url,
      streamTitle: fixture.stream_title,
      streamActive: Boolean(fixture.stream_active)
    },
    lineups,
    reserves,
    frames,
    substitutions: subs,
    attachments,
    totals: {
      completed: scored.length,
      home: homeFrames,
      away: awayFrames,
      remaining: 25 - scored.length
    }
  };
}

function pdfPlayerNames(payload) {
  const names = new Map();
  for (const p of [...payload.lineups, ...payload.reserves]) {
    names.set(Number(p.player_id), (p.first_name + " " + p.last_name).trim());
  }
  for (const fr of payload.frames) {
    names.set(Number(fr.home_player_id), fr.home_player_name);
    names.set(Number(fr.away_player_id), fr.away_player_name);
  }
  return names;
}

function drawCell(doc, x, y, w, h, text, opts = {}) {
  doc.rect(x, y, w, h).lineWidth(opts.lineWidth || 0.45).strokeColor(opts.stroke || "#b7bec7").stroke();
  if (opts.fill) doc.rect(x, y, w, h).fillColor(opts.fill).fill();

  const font = opts.bold ? "Helvetica-Bold" : "Helvetica";
  const size = opts.size || 6.2;
  doc.fillColor(opts.color || "#111111")
    .font(font)
    .fontSize(size);

  const lineHeight = doc.currentLineHeight(false);
  const textY = y + Math.max(1, (h - lineHeight) / 2 - 0.15);

  doc.text(String(text ?? ""), x + 2.5, textY, {
    width: Math.max(1, w - 5),
    height: Math.max(1, h - 2),
    align: opts.align || "left",
    ellipsis: true,
    lineBreak: false
  });
}

function drawPdfTextFit(doc, text, x, y, w, opts = {}) {
  const value = String(text ?? "");
  const font = opts.bold ? "Helvetica-Bold" : "Helvetica";
  const maxSize = Number(opts.size || 8);
  const minSize = Number(opts.minSize || Math.min(5, maxSize));
  let size = maxSize;

  doc.font(font).fontSize(size);
  while (size > minSize && doc.widthOfString(value) > Math.max(1, w - 2)) {
    size = Math.max(minSize, size - 0.25);
    doc.fontSize(size);
  }

  doc.fillColor(opts.color || "#111111")
    .font(font)
    .fontSize(size)
    .text(value, x, y, {
      width: Math.max(1, w),
      height: opts.height || (size * 1.45),
      align: opts.align || "left",
      ellipsis: true,
      lineBreak: false
    });
}


function streamOnePageScoresheetPdf(res, payload) {
  const f = payload.fixture;
  const t = payload.totals;
  const names = pdfPlayerNames(payload);
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margin: 12,
    autoFirstPage: true,
    info: { Title: `NCSF ${f.homeTeamName} vs ${f.awayTeamName}` }
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="NCSF-${String(f.homeTeamName).replace(/[^a-z0-9]+/gi,"-")}-vs-${String(f.awayTeamName).replace(/[^a-z0-9]+/gi,"-")}.pdf"`
  );
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  const W = doc.page.width;
  const H = doc.page.height;
  const left = 12;
  const usable = W - 24;
  const line = "#111111";
  const light = "#f4f4f4";
  const lighter = "#fafafa";

  const d = f.fixtureDate ? new Date(f.fixtureDate) : null;
  const dateText = d ? d.toLocaleDateString("en-GB", { timeZone: "Africa/Windhoek" }) : "TBA";
  const timeText = d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Windhoek" }) : "TBA";
  const letters = ["A","B","C","D","E"];

  const playerStat = playerId => {
    const frames = payload.frames.filter(fr =>
      (Number(fr.home_player_id) === Number(playerId) || Number(fr.away_player_id) === Number(playerId)) &&
      Boolean(fr.winner_side)
    );
    return {
      played: frames.length,
      won: frames.filter(fr => Number(fr.winner_player_id) === Number(playerId)).length
    };
  };

  const rosterRows = side => {
    const starters = payload.lineups
      .filter(p => p.side === side)
      .sort((a,b) => Number(a.slot) - Number(b.slot))
      .map((p,i) => ({
        code: side === "HOME" ? String(i + 1) : letters[i],
        name: `${p.first_name} ${p.last_name}`.trim(),
        ...playerStat(p.player_id),
        reserve: false
      }));
    const reserves = payload.reserves
      .filter(p => p.side === side)
      .sort((a,b) => Number(a.reserve_slot) - Number(b.reserve_slot))
      .map((p,i) => ({
        code: side === "HOME" ? String(i + 6) : ["F","G"][i],
        name: `${p.first_name} ${p.last_name}`.trim(),
        ...playerStat(p.player_id),
        reserve: true
      }));
    return { starters, reserves };
  };

  const drawRound = (round, x, y, w) => {
    const frames = payload.frames.filter(fr => Number(fr.round_no) === round);
    const home = frames.filter(fr => fr.winner_side === "HOME").length;
    const away = frames.filter(fr => fr.winner_side === "AWAY").length;
    const progressiveHome = payload.frames.filter(fr => Number(fr.round_no) <= round && fr.winner_side === "HOME").length;
    const progressiveAway = payload.frames.filter(fr => Number(fr.round_no) <= round && fr.winner_side === "AWAY").length;

    const titleH = 14;
    const headH = 10;
    const rowH = 15;
    const totalH = 10;
    const progressiveH = 10;

    doc.font("Helvetica-Bold").fontSize(7.2).fillColor(line)
      .text(`ROUND ${round}`, x, y + 2, { width: w, align: "center" });
    doc.font("Helvetica-Bold").fontSize(5.8)
      .text(`${home}-${away}`, x + w - 38, y + 3, { width: 34, align: "right" });

    const yHead = y + titleH;
    const slotW = 13;
    const scoreW = 18;
    const vsW = 30;
    const playerW = (w - (slotW * 2) - (scoreW * 2) - vsW) / 2;
    const widths = [slotW, playerW, scoreW, vsW, scoreW, playerW, slotW];
    const labels = ["#", "HOME TEAM", "H", "VS", "A", "AWAY TEAM", "#"];
    let cx = x;

    labels.forEach((label, idx) => {
      drawCell(doc, cx, yHead, widths[idx], headH, label, {
        size: idx === 1 || idx === 5 ? 4.5 : 4.8,
        bold: true,
        align: "center",
        fill: lighter,
        stroke: line,
        lineWidth: 0.45
      });
      cx += widths[idx];
    });

    frames.forEach((fr, i) => {
      const yy = yHead + headH + i * rowH;
      const homeBreaker = fr.break_side === "HOME";
      const vals = [
        fr.home_slot,
        fr.home_player_name,
        fr.winner_side === "HOME" ? "1" : "0",
        "vs",
        fr.winner_side === "AWAY" ? "1" : "0",
        fr.away_player_name,
        letters[(Number(fr.away_slot || 1) - 1)] || ""
      ];
      cx = x;
      vals.forEach((val, idx) => {
        drawCell(doc, cx, yy, widths[idx], rowH, val, {
          size: idx === 1 || idx === 5 ? 5.25 : idx === 3 ? 4.6 : 5.8,
          bold: idx === 2 || idx === 4 || (homeBreaker && idx === 1) || (!homeBreaker && idx === 5),
          align: "center",
          fill: (homeBreaker && idx === 1) || (!homeBreaker && idx === 5) ? "#fff0bd" : undefined,
          stroke: line,
          lineWidth: 0.45
        });
        cx += widths[idx];
      });
    });

    const totalY = yHead + headH + (5 * rowH);
    const half = w / 2;
    drawCell(doc, x, totalY, half - 18, totalH, "TOTAL", { size: 5.1, bold: true, align: "center", stroke: line });
    drawCell(doc, x + half - 18, totalY, 18, totalH, home, { size: 5.5, bold: true, align: "center", stroke: line });
    drawCell(doc, x + half, totalY, 18, totalH, away, { size: 5.5, bold: true, align: "center", stroke: line });
    drawCell(doc, x + half + 18, totalY, half - 18, totalH, "TOTAL", { size: 5.1, bold: true, align: "center", stroke: line });

    const pY = totalY + totalH;
    drawCell(doc, x, pY, half - 18, progressiveH, "Progressive Total", { size: 4.5, align: "center", stroke: line });
    drawCell(doc, x + half - 18, pY, 18, progressiveH, progressiveHome, { size: 5.2, bold: true, align: "center", stroke: line });
    drawCell(doc, x + half, pY, 18, progressiveH, progressiveAway, { size: 5.2, bold: true, align: "center", stroke: line });
    drawCell(doc, x + half + 18, pY, half - 18, progressiveH, "Progressive Total", { size: 4.5, align: "center", stroke: line });

    return titleH + headH + (5 * rowH) + totalH + progressiveH;
  };

  const drawDetailLine = (x, y, label, value, w) => {
    const labelW = 105;
    doc.font("Helvetica-Bold").fontSize(5.4).fillColor(line)
      .text(label, x, y + 4, { width: labelW - 5 });
    drawCell(doc, x + labelW, y, w - labelW, 15, value || "-", {
      size: 5.4,
      align: "center",
      stroke: "#777777",
      lineWidth: 0.4
    });
  };

  const drawRoster = (side, x, y, w) => {
    const data = rosterRows(side);
    const sideTitle = side === "HOME" ? "HOME TEAM" : "AWAY TEAM";
    const codeW = 18;
    const pW = 22;
    const wW = 22;
    const nameW = w - codeW - pW - wW;
    const rowH = 12;
    const headH = 10;
    const reserveH = 9;
    const totalH = 11;

    doc.font("Helvetica-Bold").fontSize(6.3).fillColor(line)
      .text(sideTitle, x, y, { width: w, align: "center" });

    let yy = y + 10;
    drawCell(doc, x, yy, codeW, headH, "", { fill: light, stroke: line });
    drawCell(doc, x + codeW, yy, nameW, headH, "", { fill: light, stroke: line });
    drawCell(doc, x + codeW + nameW, yy, pW, headH, "P", { size: 5, bold: true, align: "center", fill: light, stroke: line });
    drawCell(doc, x + codeW + nameW + pW, yy, wW, headH, "W", { size: 5, bold: true, align: "center", fill: light, stroke: line });
    yy += headH;

    data.starters.forEach(r => {
      drawCell(doc, x, yy, codeW, rowH, r.code, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW, yy, nameW, rowH, r.name, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW + nameW, yy, pW, rowH, r.played, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW + nameW + pW, yy, wW, rowH, r.won, { size: 5.2, align: "center", stroke: line });
      yy += rowH;
    });

    drawCell(doc, x, yy, w, reserveH, "RESERVES", {
      size: 4.8, bold: true, align: "center", fill: light, stroke: line
    });
    yy += reserveH;

    data.reserves.forEach(r => {
      drawCell(doc, x, yy, codeW, rowH, r.code, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW, yy, nameW, rowH, r.name, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW + nameW, yy, pW, rowH, r.played, { size: 5.2, align: "center", stroke: line });
      drawCell(doc, x + codeW + nameW + pW, yy, wW, rowH, r.won, { size: 5.2, align: "center", stroke: line });
      yy += rowH;
    });

    drawCell(doc, x, yy, codeW + nameW, totalH, "TOTAL", {
      size: 5.2, bold: true, align: "right", stroke: line
    });
    drawCell(doc, x + codeW + nameW, yy, pW, totalH, t.completed, {
      size: 5.5, bold: true, align: "center", stroke: line
    });
    drawCell(doc, x + codeW + nameW + pW, yy, wW, totalH, side === "HOME" ? t.home : t.away, {
      size: 5.5, bold: true, align: "center", stroke: line
    });

    return yy + totalH;
  };

  try {
    doc.image(getNcsfLogoJpeg(), left + 2, 13, { fit: [38, 38], align: "center", valign: "center" });
  } catch (_e) {}

  drawPdfTextFit(doc, "NAMIBIA CUE SPORTS FEDERATION", 56, 15, usable - 90, {
    size: 12.5, minSize: 10.5, bold: true, align: "center", color: line, height: 16
  });
  drawPdfTextFit(doc, "Blackball League Scoresheet", 56, 30, usable - 90, {
    size: 9.1, minSize: 7.5, bold: true, align: "center", color: line, height: 12
  });
  drawPdfTextFit(doc, `${f.seasonName || ""} - ${f.divisionName || ""} - Round ${f.roundNo || ""}`, 56, 43, usable - 90, {
    size: 5.2, minSize: 4.3, align: "center", color: "#444444", height: 8
  });
  drawPdfTextFit(doc, `STARTING TIME: ${timeText}   |   DATE: ${dateText}   |   VENUE: ${f.venue || "TBA"}`, left, 54, usable, {
    size: 5.2, minSize: 4.2, align: "center", color: line, height: 8
  });

  const teamLabelY = 66;
  const teamBoxY = 75;
  const teamGap = 38;
  const teamW = (usable - teamGap) / 2;
  doc.font("Helvetica-Bold").fontSize(5).fillColor(line).text("HOME TEAM", left, teamLabelY);
  doc.text("AWAY TEAM", left + teamW + teamGap, teamLabelY);
  drawCell(doc, left, teamBoxY, teamW, 22, "", { stroke: line, lineWidth: 0.6 });
  drawPdfTextFit(doc, f.homeTeamName, left + 4, teamBoxY + 6, teamW - 8, {
    size: 8.3, minSize: 5.5, bold: true, align: "center", color: line, height: 10
  });
  drawCell(doc, left + teamW + teamGap, teamBoxY, teamW, 22, "", { stroke: line, lineWidth: 0.6 });
  drawPdfTextFit(doc, f.awayTeamName, left + teamW + teamGap + 4, teamBoxY + 6, teamW - 8, {
    size: 8.3, minSize: 5.5, bold: true, align: "center", color: line, height: 10
  });
  doc.font("Helvetica-Bold").fontSize(7).fillColor(line)
    .text("vs", left + teamW, teamBoxY + 7, { width: teamGap, align: "center" });

  const roundsY = 108;
  const gapX = 8;
  const gapY = 6;
  const colW = (usable - gapX) / 2;
  const roundH = 119;

  const round5X = left + (usable - colW) / 2;

  drawRound(1, left, roundsY, colW);
  drawRound(2, left + colW + gapX, roundsY, colW);
  drawRound(3, left, roundsY + roundH + gapY, colW);
  drawRound(4, left + colW + gapX, roundsY + roundH + gapY, colW);
  drawRound(5, round5X, roundsY + (roundH + gapY) * 2, colW);

  const finalY = roundsY + (roundH + gapY) * 2 + roundH + 8;
  const centerScoreW = 34;
  const finalLabelW = (usable - (centerScoreW * 2)) / 2;
  drawCell(doc, left, finalY, finalLabelW, 18, "FINAL TOTAL", { size: 5.7, bold: true, align: "center", stroke: line, lineWidth: 0.6 });
  drawCell(doc, left + finalLabelW, finalY, centerScoreW, 18, t.home, { size: 7.8, bold: true, align: "center", stroke: line, lineWidth: 0.6 });
  drawCell(doc, left + finalLabelW + centerScoreW, finalY, centerScoreW, 18, t.away, { size: 7.8, bold: true, align: "center", stroke: line, lineWidth: 0.6 });
  drawCell(doc, left + finalLabelW + (centerScoreW * 2), finalY, finalLabelW, 18, "FINAL TOTAL", { size: 5.7, bold: true, align: "center", stroke: line, lineWidth: 0.6 });

  const detailY = finalY + 24;
  const detailGap = 18;
  const detailW = (usable - detailGap) / 2;
  const matchResult = t.completed < 25
    ? "IN PROGRESS"
    : (t.home > t.away ? `${f.homeTeamName} WIN` : t.away > t.home ? `${f.awayTeamName} WIN` : "DRAW");

  const playerOfMatchText = (f.playerOfMatchIds || [])
    .map(id => names.get(Number(id)))
    .filter(Boolean)
    .join(", ") || "-";
  const breakRunText = (f.breakRunPlayerIds || [])
    .map(id => names.get(Number(id)))
    .filter(Boolean)
    .join(", ") || "-";
  const bonusText = f.bonusTeamName ? `${f.bonusTeamName} (+1)` : "-";

  drawDetailLine(left, detailY, "Player/s of Tournament", playerOfMatchText, detailW);
  drawDetailLine(left, detailY + 18, "Break & Run", breakRunText, detailW);
  drawDetailLine(left, detailY + 36, "Rack & Run", names.get(Number(f.rackRunPlayerId)) || "-", detailW);
  drawDetailLine(left, detailY + 54, "Bonus Point", bonusText, detailW);

  const rightX = left + detailW + detailGap;
  drawDetailLine(rightX, detailY, "Match Result", matchResult, detailW);
  drawDetailLine(rightX, detailY + 18, "Home Frames Won", String(t.home), detailW);
  drawDetailLine(rightX, detailY + 36, "Away Frames Won", String(t.away), detailW);
  drawDetailLine(rightX, detailY + 54, "Status", String(f.status || "").replaceAll("_"," "), detailW);

  const rosterY = detailY + 82;
  const rosterGap = 18;
  const rosterW = (usable - rosterGap) / 2;
  const homeRosterEnd = drawRoster("HOME", left, rosterY, rosterW);
  const awayRosterEnd = drawRoster("AWAY", left + rosterW + rosterGap, rosterY, rosterW);

  const signY = Math.max(homeRosterEnd, awayRosterEnd) + 12;
  const homeCaptain = names.get(Number(f.homeCaptainId)) || "-";
  const awayCaptain = names.get(Number(f.awayCaptainId)) || "-";
  const sigW = (usable - 20) / 2;
  const awaySigX = left + sigW + 20;

  doc.font("Helvetica-Bold").fontSize(5.4).fillColor(line)
    .text(`CAPTAIN SIGNATURE (HOME):`, left, signY, { width: sigW });
  drawPdfTextFit(doc, homeCaptain, left, signY + 9, sigW, {
    size: 5.2, minSize: 4.2, bold: true, align: "center", color: line, height: 8
  });
  doc.moveTo(left, signY + 25).lineTo(left + sigW, signY + 25).strokeColor(line).lineWidth(0.55).stroke();

  doc.font("Helvetica-Bold").fontSize(5.4).fillColor(line)
    .text(`CAPTAIN SIGNATURE (AWAY):`, awaySigX, signY, { width: sigW });
  drawPdfTextFit(doc, awayCaptain, awaySigX, signY + 9, sigW, {
    size: 5.2, minSize: 4.2, bold: true, align: "center", color: line, height: 8
  });
  doc.moveTo(awaySigX, signY + 25).lineTo(awaySigX + sigW, signY + 25).strokeColor(line).lineWidth(0.55).stroke();

  doc.font("Helvetica").fontSize(4.2).fillColor("#777777")
    .text("Generated by NCSF League Manager", left, H - 22, { width: usable, height: 7, align: "center", lineBreak: false });

  doc.end();
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/setup/status", async (_req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*)::int count FROM users");
  res.json({ needsSetup: rows[0].count === 0 });
});

app.post("/api/setup", async (req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*)::int count FROM users");
  if (rows[0].count !== 0) return res.status(409).json({ error: "Initial setup has already been completed." });

  const email = cleanEmail(req.body.email);
  const name = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  if (!email || !name || password.length < 8) {
    return res.status(400).json({ error: "Name, valid email and a password of at least 8 characters are required." });
  }

  const hash = await bcrypt.hash(password, 12);
  const created = await pool.query(`
    INSERT INTO users(email,password_hash,display_name,role)
    VALUES($1,$2,$3,'NCSF_ADMIN')
    RETURNING *
  `, [email, hash, name]);

  req.session.userId = created.rows[0].id;
  res.status(201).json({ user: safeUser(created.rows[0]) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || "");
  const { rows } = await pool.query("SELECT * FROM users WHERE email=$1 AND active=TRUE", [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.userId = user.id;
  const hydrated = await currentUserById(user.id);
  res.json({ user: safeUser(hydrated) });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await currentUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }
  res.json({ user: safeUser(user) });
});

app.get("/api/public/meta", async (_req, res) => {
  const [seasons, divisions, clubs] = await Promise.all([
    pool.query("SELECT * FROM seasons ORDER BY active DESC, start_date DESC NULLS LAST, id DESC"),
    pool.query(`
      SELECT d.*, s.name season_name
      FROM divisions d JOIN seasons s ON s.id=d.season_id
      WHERE d.active=TRUE ORDER BY s.active DESC, d.sort_order, d.name
    `),
    pool.query("SELECT id,name,short_name FROM clubs WHERE active=TRUE ORDER BY name")
  ]);
  res.json({ seasons: seasons.rows, divisions: divisions.rows, clubs: clubs.rows });
});

app.get("/api/public/overview", async (_req, res) => {
  const { rows: divRows } = await pool.query(`
    SELECT d.id,d.name,s.name season_name
    FROM divisions d JOIN seasons s ON s.id=d.season_id
    WHERE d.active=TRUE
    ORDER BY s.active DESC,d.sort_order,d.id
    LIMIT 1
  `);
  const division = divRows[0] || null;
  const { rows: fixtures } = await pool.query(`
    SELECT f.id,f.round_no,f.fixture_date,f.status,f.venue,
           ht.name home_team_name,at.name away_team_name,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME')::int home_frames,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY')::int away_frames
    FROM fixtures f
    JOIN teams ht ON ht.id=f.home_team_id
    JOIN teams at ON at.id=f.away_team_id
    LEFT JOIN frames fr ON fr.fixture_id=f.id
    GROUP BY f.id,ht.name,at.name
    ORDER BY COALESCE(f.fixture_date, f.created_at) DESC
    LIMIT 12
  `);
  const standings = division ? await getStandings(division.id) : [];
  const players = division ? await getIndividualRankings(division.id) : [];
  res.json({ division, fixtures, standings: standings.slice(0, 8), topPlayers: players.slice(0, 10) });
});


app.get("/api/public/posts", async (req, res) => {
  const args = [];
  const where = ["published=TRUE"];
  if (req.query.type) {
    const type = String(req.query.type).toUpperCase();
    if (!["NEWS","ANNOUNCEMENT","EVENT"].includes(type)) return res.status(400).json({ error: "Invalid post type." });
    args.push(type);
    where.push("type=$" + args.length);
  }
  const { rows } = await pool.query(
    "SELECT id,type,title,body,event_date,pinned,created_at,updated_at FROM content_posts WHERE " +
    where.join(" AND ") +
    " ORDER BY pinned DESC, CASE WHEN type='EVENT' AND event_date >= NOW() THEN 0 WHEN type='ANNOUNCEMENT' THEN 1 WHEN type='NEWS' THEN 2 ELSE 3 END, CASE WHEN type='EVENT' THEN event_date END ASC NULLS LAST, created_at DESC LIMIT 100",
    args
  );
  res.json({ posts: rows });
});

app.get("/api/public/opportunities", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id,title,discipline,organizer,location,start_date,end_date,registration_deadline,
           entry_fee,prize_fund,eligibility,status,description,registration_url,official_url,updated_at
    FROM tournament_opportunities
    WHERE published=TRUE AND (end_date IS NULL OR end_date >= CURRENT_DATE)
    ORDER BY start_date ASC NULLS LAST,title ASC
    LIMIT 200
  `);
  res.json({ opportunities: rows });
});

app.get("/api/public/teams", async (req, res) => {
  const args = [];
  const where = ["t.active=TRUE"];
  if (req.query.divisionId) {
    args.push(Number(req.query.divisionId));
    where.push(`t.division_id=$${args.length}`);
  }
  const { rows } = await pool.query(`
    SELECT t.id,t.name,t.short_name,t.division_id,c.name club_name,d.name division_name,s.name season_name,
           COUNT(p.id) FILTER (WHERE p.active=TRUE)::int player_count
    FROM teams t
    JOIN clubs c ON c.id=t.club_id
    LEFT JOIN divisions d ON d.id=t.division_id
    LEFT JOIN seasons s ON s.id=d.season_id
    LEFT JOIN players p ON p.team_id=t.id
    WHERE ${where.join(" AND ")}
    GROUP BY t.id,c.name,d.id,d.name,d.sort_order,s.id,s.name
    ORDER BY COALESCE(d.sort_order,999),c.name,t.name
  `, args);
  res.json({ teams: rows });
});

app.get("/api/public/players", async (req, res) => {
  const args = [];
  const where = ["p.active=TRUE","t.active=TRUE"];
  if (req.query.divisionId) {
    args.push(Number(req.query.divisionId));
    where.push(`t.division_id=$${args.length}`);
  }
  if (req.query.teamId) {
    args.push(Number(req.query.teamId));
    where.push(`p.team_id=$${args.length}`);
  }
  const { rows } = await pool.query(`
    SELECT p.id,p.ncsf_number,p.first_name,p.last_name,t.id team_id,t.name team_name,
           c.name club_name,d.id division_id,d.name division_name,
           COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL)::int frames_played,
           COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL AND fr.winner_player_id=p.id)::int frames_won,
           CASE WHEN COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL)=0 THEN 0
                ELSE ROUND((COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL AND fr.winner_player_id=p.id)::numeric /
                           NULLIF(COUNT(fr.id) FILTER (WHERE f.id IS NOT NULL),0)::numeric) * 100, 1)
           END win_percentage
    FROM players p
    JOIN teams t ON t.id=p.team_id
    JOIN clubs c ON c.id=p.club_id
    LEFT JOIN divisions d ON d.id=t.division_id
    LEFT JOIN frames fr ON (fr.home_player_id=p.id OR fr.away_player_id=p.id)
    LEFT JOIN fixtures f ON f.id=fr.fixture_id AND f.status='APPROVED'
    WHERE ${where.join(" AND ")}
    GROUP BY p.id,t.id,t.name,c.name,d.id,d.name
    ORDER BY p.last_name,p.first_name
  `, args);
  res.json({ players: rows });
});

app.get("/api/divisions/:id/standings", async (req, res) => {
  res.json({ standings: await getStandings(Number(req.params.id)) });
});

app.get("/api/divisions/:id/individual-rankings", async (req, res) => {
  res.json({ rankings: await getIndividualRankings(Number(req.params.id)) });
});

app.get("/api/fixtures", async (req, res) => {
  const args = [];
  const where = [];
  if (!req.session.userId) {
    where.push("(f.status IN ('SCHEDULED','IN_PROGRESS','POSTPONED','APPROVED') OR (f.stream_active=TRUE AND f.stream_url IS NOT NULL))");
  }
  if (req.query.divisionId) {
    args.push(Number(req.query.divisionId));
    where.push(`f.division_id=$${args.length}`);
  }
  if (req.query.teamId) {
    args.push(Number(req.query.teamId));
    where.push(`(f.home_team_id=$${args.length} OR f.away_team_id=$${args.length})`);
  }
  if (req.query.status) {
    const statuses = String(req.query.status).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const allowed = ['SCHEDULED','IN_PROGRESS','SUBMITTED','CONFIRMED','APPROVED','POSTPONED','FORFEIT'];
    if (!statuses.length || statuses.some(s => !allowed.includes(s))) return res.status(400).json({ error: "Invalid fixture status." });
    args.push(statuses);
    where.push(`f.status = ANY($${args.length}::text[])`);
  }
  const { rows } = await pool.query(`
    SELECT f.id,f.division_id,f.round_no,f.fixture_date,f.status,f.venue,
           f.stream_url,f.stream_title,f.stream_active,
           d.name division_name,s.name season_name,
           ht.id home_team_id,ht.name home_team_name,
           at.id away_team_id,at.name away_team_name,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME')::int home_frames,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY')::int away_frames
    FROM fixtures f
    JOIN divisions d ON d.id=f.division_id
    JOIN seasons s ON s.id=d.season_id
    JOIN teams ht ON ht.id=f.home_team_id
    JOIN teams at ON at.id=f.away_team_id
    LEFT JOIN frames fr ON fr.fixture_id=f.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    GROUP BY f.id,d.name,s.name,ht.id,at.id
    ORDER BY f.fixture_date NULLS LAST,f.round_no,f.id
  `, args);
  res.json({ fixtures: rows });
});

app.get("/api/live/:id", async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (!fixture.stream_active || !fixture.stream_url) return res.status(404).json({ error: "No live stream is available for this fixture." });
  res.json({
    live: {
      fixtureId: fixture.id,
      title: fixture.stream_title || (fixture.home_team_name + " vs " + fixture.away_team_name),
      streamUrl: fixture.stream_url,
      homeTeamName: fixture.home_team_name,
      awayTeamName: fixture.away_team_name,
      fixtureDate: fixture.fixture_date,
      venue: fixture.venue,
      divisionName: fixture.division_name
    }
  });
});


app.get("/api/live/:id/chat", async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });

  const { rows } = await pool.query(`
    SELECT id,fixture_id,user_id,display_name,role,message,created_at
    FROM live_chat_messages
    WHERE fixture_id=$1
    ORDER BY created_at DESC,id DESC
    LIMIT 100
  `, [fixtureId]);

  res.json({ messages: rows.reverse() });
});

app.post("/api/live/:id/chat", requireAuth, async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (!fixture.stream_active) return res.status(409).json({ error: "Live chat is available while the fixture is live." });

  const user = await currentUserById(req.session.userId);
  if (!user || !user.active) return res.status(403).json({ error: "Active NCSF sign-in required." });

  const message = String(req.body.message || "").replace(/\s+/g, " ").trim();
  if (!message) return res.status(400).json({ error: "Enter a chat message." });
  if (message.length > 280) return res.status(400).json({ error: "Chat messages are limited to 280 characters." });

  const { rows } = await pool.query(`
    INSERT INTO live_chat_messages(fixture_id,user_id,display_name,role,message)
    VALUES($1,$2,$3,$4,$5)
    RETURNING id,fixture_id,user_id,display_name,role,message,created_at
  `, [fixtureId, user.id, user.display_name, user.role, message]);

  const chatMessage = rows[0];
  const liveState = liveStateFor(fixtureId);
  for (const client of liveState.chatClients) {
    sendLiveControl(client, { type: "chat-message", message: chatMessage });
  }
  res.status(201).json({ message: chatMessage });
});

app.post("/api/fixtures/:id/broadcast-token", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to broadcast this fixture." });
  if (fixture.status === "APPROVED") return res.status(409).json({ error: "Approved fixtures cannot be broadcast as live matches." });
  const token = issueBroadcastToken(fixture.id, user.id);
  res.json({ token, fixtureId: fixture.id, title: fixture.home_team_name + " vs " + fixture.away_team_name });
});

app.get("/api/fixtures/:id/pdf", async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (fixture.status !== "APPROVED") {
    const user = req.session.userId ? await currentUserById(req.session.userId) : null;
    if (!canManageFixture(user, fixture)) return res.status(403).json({ error: "This scoresheet is not public yet." });
  }
  const payload = await fixturePayload(fixture);
  streamOnePageScoresheetPdf(res, payload);
});

app.get("/api/teams/:id/players", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id,ncsf_number,first_name,last_name,active,suspended
    FROM players WHERE team_id=$1 AND active=TRUE
    ORDER BY last_name,first_name
  `, [Number(req.params.id)]);
  res.json({ players: rows });
});

app.get("/api/fixtures/:id", async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });

  if (fixture.status !== "APPROVED") {
    const user = req.session.userId ? await currentUserById(req.session.userId) : null;
    if (!canManageFixture(user, fixture)) return res.status(403).json({ error: "This score sheet is not public yet." });
  }
  res.json(await fixturePayload(fixture));
});

app.get("/api/fixtures/:id/attachment/:attachmentId", async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture) return res.status(404).end();
  if (fixture.status !== "APPROVED") {
    const user = req.session.userId ? await currentUserById(req.session.userId) : null;
    if (!canManageFixture(user, fixture)) return res.status(403).end();
  }
  const { rows } = await pool.query(
    "SELECT filename,mimetype,file_data FROM fixture_attachments WHERE id=$1 AND fixture_id=$2",
    [Number(req.params.attachmentId), fixture.id]
  );
  if (!rows[0]) return res.status(404).end();
  res.setHeader("Content-Type", rows[0].mimetype);
  res.setHeader("Content-Disposition", `inline; filename="${rows[0].filename.replace(/"/g, "")}"`);
  res.send(rows[0].file_data);
});

app.get("/api/my/fixtures", requireAuth, async (req, res) => {
  const user = await currentUserById(req.session.userId);
  let condition = "TRUE";
  const args = [];
  if (user.role === ROLE.CLUB) {
    args.push(user.club_id);
    condition = `(ht.club_id=$1 OR at.club_id=$1)`;
  } else if (user.role === ROLE.TEAM) {
    args.push(user.team_id);
    condition = `(f.home_team_id=$1 OR f.away_team_id=$1)`;
  }
  const { rows } = await pool.query(`
    SELECT f.id,f.round_no,f.fixture_date,f.status,f.venue,
           f.stream_url,f.stream_title,f.stream_active,d.name division_name,
           ht.name home_team_name,at.name away_team_name,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME')::int home_frames,
           COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY')::int away_frames
    FROM fixtures f
    JOIN divisions d ON d.id=f.division_id
    JOIN teams ht ON ht.id=f.home_team_id
    JOIN teams at ON at.id=f.away_team_id
    LEFT JOIN frames fr ON fr.fixture_id=f.id
    WHERE ${condition}
    GROUP BY f.id,d.name,ht.name,at.name
    ORDER BY f.fixture_date NULLS LAST,f.id
  `, args);
  res.json({ fixtures: rows });
});

app.get("/api/admin/dashboard", requireRoles(ROLE.NCSF), async (_req, res) => {
  const [counts, statusRows, pending, missingAccess] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM clubs WHERE active=TRUE) clubs,
        (SELECT COUNT(*)::int FROM teams WHERE active=TRUE) teams,
        (SELECT COUNT(*)::int FROM players WHERE active=TRUE) players,
        (SELECT COUNT(*)::int FROM divisions WHERE active=TRUE) divisions,
        (SELECT COUNT(*)::int FROM fixtures) fixtures
    `),
    pool.query("SELECT status, COUNT(*)::int count FROM fixtures GROUP BY status ORDER BY status"),
    pool.query(`
      SELECT f.id,f.round_no,f.fixture_date,f.status,d.name division_name,
             ht.name home_team_name,at.name away_team_name,
             COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME')::int home_frames,
             COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY')::int away_frames
      FROM fixtures f
      JOIN divisions d ON d.id=f.division_id
      JOIN teams ht ON ht.id=f.home_team_id
      JOIN teams at ON at.id=f.away_team_id
      LEFT JOIN frames fr ON fr.fixture_id=f.id
      WHERE f.status IN ('SUBMITTED','CONFIRMED')
      GROUP BY f.id,d.name,ht.name,at.name
      ORDER BY f.fixture_date NULLS LAST,f.id
      LIMIT 20
    `),
    pool.query(`
      SELECT t.id,t.name team_name,c.name club_name
      FROM teams t
      JOIN clubs c ON c.id=t.club_id
      LEFT JOIN users u ON u.team_id=t.id AND u.role='TEAM_ADMIN' AND u.active=TRUE
      WHERE t.active=TRUE
      GROUP BY t.id,c.name
      HAVING COUNT(u.id)=0
      ORDER BY c.name,t.name
    `)
  ]);
  const byStatus = Object.fromEntries(statusRows.rows.map(r => [r.status, r.count]));
  res.json({ counts: counts.rows[0], byStatus, pending: pending.rows, missingAccess: missingAccess.rows });
});

app.get("/api/admin/meta", requireRoles(ROLE.NCSF, ROLE.CLUB, ROLE.TEAM), async (req, res) => {
  const user = req.user;
  if (user.role === ROLE.NCSF) {
    const [seasons, divisions, clubs, teams, players, users] = await Promise.all([
      pool.query("SELECT * FROM seasons ORDER BY id DESC"),
      pool.query("SELECT d.*,s.name season_name FROM divisions d JOIN seasons s ON s.id=d.season_id ORDER BY d.id DESC"),
      pool.query("SELECT * FROM clubs ORDER BY name"),
      pool.query("SELECT t.*,c.name club_name,d.name division_name FROM teams t JOIN clubs c ON c.id=t.club_id LEFT JOIN divisions d ON d.id=t.division_id ORDER BY t.name"),
      pool.query("SELECT p.*,c.name club_name,t.name team_name FROM players p JOIN clubs c ON c.id=p.club_id LEFT JOIN teams t ON t.id=p.team_id ORDER BY p.last_name,p.first_name"),
      pool.query("SELECT u.id,u.email,u.display_name,u.role,u.club_id,u.team_id,u.active,c.name club_name,t.name team_name FROM users u LEFT JOIN clubs c ON c.id=u.club_id LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.display_name")
    ]);
    return res.json({ seasons: seasons.rows, divisions: divisions.rows, clubs: clubs.rows, teams: teams.rows, players: players.rows, users: users.rows });
  }

  const clubId = user.club_id;
  const [divisions, clubs, teams, players, users] = await Promise.all([
    pool.query("SELECT d.*,s.name season_name FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.active=TRUE ORDER BY d.name"),
    pool.query("SELECT * FROM clubs WHERE id=$1", [clubId]),
    pool.query("SELECT t.*,c.name club_name,d.name division_name FROM teams t JOIN clubs c ON c.id=t.club_id LEFT JOIN divisions d ON d.id=t.division_id WHERE t.club_id=$1 ORDER BY t.name", [clubId]),
    pool.query("SELECT p.*,c.name club_name,t.name team_name FROM players p JOIN clubs c ON c.id=p.club_id LEFT JOIN teams t ON t.id=p.team_id WHERE p.club_id=$1 ORDER BY p.last_name,p.first_name", [clubId]),
    pool.query("SELECT u.id,u.email,u.display_name,u.role,u.club_id,u.team_id,u.active,c.name club_name,t.name team_name FROM users u LEFT JOIN clubs c ON c.id=u.club_id LEFT JOIN teams t ON t.id=u.team_id WHERE u.club_id=$1 ORDER BY u.display_name", [clubId])
  ]);
  const filteredTeams = user.role === ROLE.TEAM ? teams.rows.filter(t => t.id === user.team_id) : teams.rows;
  const filteredPlayers = user.role === ROLE.TEAM ? players.rows.filter(p => p.team_id === user.team_id) : players.rows;
  res.json({ seasons: [], divisions: divisions.rows, clubs: clubs.rows, teams: filteredTeams, players: filteredPlayers, users: users.rows });
});


app.get("/api/admin/posts", requireRoles(ROLE.NCSF), async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM content_posts ORDER BY pinned DESC, COALESCE(event_date,created_at) DESC, id DESC");
  res.json({ posts: rows });
});

app.post("/api/admin/posts", requireRoles(ROLE.NCSF), async (req, res) => {
  const type = String(req.body.type || "ANNOUNCEMENT").toUpperCase();
  const title = String(req.body.title || "").trim();
  const body = String(req.body.body || "").trim() || null;
  if (!["NEWS","ANNOUNCEMENT","EVENT"].includes(type)) return res.status(400).json({ error: "Invalid post type." });
  if (!title) return res.status(400).json({ error: "Title is required." });
  const eventDate = type === "EVENT" ? (req.body.eventDate || null) : null;
  if (type === "EVENT" && !eventDate) return res.status(400).json({ error: "Event date/time is required." });
  const { rows } = await pool.query(
    "INSERT INTO content_posts(type,title,body,event_date,published,pinned,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [type,title,body,eventDate,req.body.published !== false,Boolean(req.body.pinned),req.user.id]
  );
  res.status(201).json({ post: rows[0] });
});

app.patch("/api/admin/posts/:id", requireRoles(ROLE.NCSF), async (req, res) => {
  const id = Number(req.params.id);
  const current = await pool.query("SELECT * FROM content_posts WHERE id=$1", [id]);
  if (!current.rowCount) return res.status(404).json({ error: "Post not found." });
  const p = current.rows[0];
  const type = req.body.type === undefined ? p.type : String(req.body.type).toUpperCase();
  if (!["NEWS","ANNOUNCEMENT","EVENT"].includes(type)) return res.status(400).json({ error: "Invalid post type." });
  const title = req.body.title === undefined ? p.title : String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Title is required." });
  const body = req.body.body === undefined ? p.body : (String(req.body.body || "").trim() || null);
  const eventDate = type === "EVENT" ? (req.body.eventDate === undefined ? p.event_date : (req.body.eventDate || null)) : null;
  const published = req.body.published === undefined ? p.published : Boolean(req.body.published);
  const pinned = req.body.pinned === undefined ? p.pinned : Boolean(req.body.pinned);
  const { rows } = await pool.query(
    "UPDATE content_posts SET type=$2,title=$3,body=$4,event_date=$5,published=$6,pinned=$7,updated_at=NOW() WHERE id=$1 RETURNING *",
    [id,type,title,body,eventDate,published,pinned]
  );
  res.json({ post: rows[0] });
});

app.delete("/api/admin/posts/:id", requireRoles(ROLE.NCSF), async (req, res) => {
  await pool.query("DELETE FROM content_posts WHERE id=$1", [Number(req.params.id)]);
  res.json({ ok: true });
});

const opportunityStatuses = new Set(["OPEN","COMING_SOON","WAITLIST","INVITATION_ONLY","CLOSED"]);
const opportunityDisciplines = new Set(["HEYBALL","BLACKBALL","8-BALL","9-BALL","10-BALL","OTHER"]);

function normalizeOpportunityInput(body={}, current=null) {
  const value=(key,currentKey=key,fallback="")=>body[key]===undefined?(current?.[currentKey]??fallback):body[key];
  const title=String(value("title")||"").trim();
  if(!title) return {error:"Tournament name is required."};
  if(title.length>180) return {error:"Tournament name must be 180 characters or fewer."};

  const discipline=String(value("discipline","discipline","HEYBALL")||"HEYBALL").trim().toUpperCase();
  if(!opportunityDisciplines.has(discipline)) return {error:"Choose a supported cue-sports discipline."};
  const status=String(value("status","status","COMING_SOON")||"COMING_SOON").trim().toUpperCase();
  if(!opportunityStatuses.has(status)) return {error:"Choose a valid registration status."};

  const readText=(key,currentKey=key,max=500)=>{
    const raw=value(key,currentKey,"");
    const text=String(raw??"").trim();
    return text?(text.length>max?false:text):null;
  };
  const organizer=readText("organizer","organizer",160);
  const location=readText("location","location",200);
  const entryFee=readText("entry_fee","entry_fee",100);
  const prizeFund=readText("prize_fund","prize_fund",100);
  const eligibility=readText("eligibility","eligibility",240);
  const description=readText("description","description",1200);
  if([organizer,location,entryFee,prizeFund,eligibility,description].includes(false)) return {error:"One of the tournament details is too long."};

  const readDate=(key,currentKey=key)=>{
    const raw=value(key,currentKey,"");
    if(raw===null||raw==="") return null;
    const date=String(raw).trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+"T00:00:00Z"))||new Date(date+"T00:00:00Z").toISOString().slice(0,10)!==date) return false;
    return date;
  };
  const startDate=readDate("start_date"),endDate=readDate("end_date"),deadline=readDate("registration_deadline");
  if(startDate===false||endDate===false||deadline===false) return {error:"Enter valid tournament dates."};
  if(startDate&&endDate&&endDate<startDate) return {error:"End date cannot be before the start date."};

  const readUrl=(key,currentKey=key)=>{
    const raw=value(key,currentKey,"");
    if(!raw) return null;
    try{
      const url=new URL(String(raw).trim());
      if(!["http:","https:"].includes(url.protocol)) return false;
      return url.toString();
    }catch(_e){return false}
  };
  const registrationUrl=readUrl("registration_url"),officialUrl=readUrl("official_url");
  if(registrationUrl===false||officialUrl===false) return {error:"Use a valid http or https link for event and registration URLs."};

  const publishedRaw=value("published","published",true);
  const published=typeof publishedRaw==="boolean"?publishedRaw:publishedRaw==="true"||publishedRaw==="on"||publishedRaw==="1";
  return {data:{
    title,discipline,organizer,location,start_date:startDate,end_date:endDate,registration_deadline:deadline,
    entry_fee:entryFee,prize_fund:prizeFund,eligibility,status,description,
    registration_url:registrationUrl,official_url:officialUrl,published
  }};
}

app.get("/api/admin/opportunities", requireRoles(ROLE.NCSF), async (_req,res) => {
  const {rows}=await pool.query("SELECT * FROM tournament_opportunities ORDER BY start_date ASC NULLS LAST,id DESC");
  res.json({opportunities:rows});
});

app.post("/api/admin/opportunities", requireRoles(ROLE.NCSF), async (req,res) => {
  const normalized=normalizeOpportunityInput(req.body);
  if(normalized.error) return res.status(400).json({error:normalized.error});
  const o=normalized.data;
  const {rows}=await pool.query(`
    INSERT INTO tournament_opportunities
      (title,discipline,organizer,location,start_date,end_date,registration_deadline,entry_fee,prize_fund,
       eligibility,status,description,registration_url,official_url,published,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *
  `,[o.title,o.discipline,o.organizer,o.location,o.start_date,o.end_date,o.registration_deadline,
      o.entry_fee,o.prize_fund,o.eligibility,o.status,o.description,o.registration_url,o.official_url,o.published,req.user.id]);
  res.status(201).json({opportunity:rows[0]});
});

app.patch("/api/admin/opportunities/:id", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1) return res.status(400).json({error:"Invalid opportunity."});
  const currentResult=await pool.query("SELECT * FROM tournament_opportunities WHERE id=$1",[id]);
  if(!currentResult.rowCount) return res.status(404).json({error:"Opportunity not found."});
  const normalized=normalizeOpportunityInput(req.body,currentResult.rows[0]);
  if(normalized.error) return res.status(400).json({error:normalized.error});
  const o=normalized.data;
  const {rows}=await pool.query(`
    UPDATE tournament_opportunities
    SET title=$2,discipline=$3,organizer=$4,location=$5,start_date=$6,end_date=$7,registration_deadline=$8,
        entry_fee=$9,prize_fund=$10,eligibility=$11,status=$12,description=$13,registration_url=$14,
        official_url=$15,published=$16,updated_at=NOW()
    WHERE id=$1 RETURNING *
  `,[id,o.title,o.discipline,o.organizer,o.location,o.start_date,o.end_date,o.registration_deadline,
      o.entry_fee,o.prize_fund,o.eligibility,o.status,o.description,o.registration_url,o.official_url,o.published]);
  res.json({opportunity:rows[0]});
});

app.delete("/api/admin/opportunities/:id", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1) return res.status(400).json({error:"Invalid opportunity."});
  const result=await pool.query("DELETE FROM tournament_opportunities WHERE id=$1",[id]);
  if(!result.rowCount) return res.status(404).json({error:"Opportunity not found."});
  res.json({ok:true});
});

app.post("/api/admin/seasons", requireRoles(ROLE.NCSF), async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Season name is required." });
  if (req.body.active) await pool.query("UPDATE seasons SET active=FALSE");
  const { rows } = await pool.query(
    "INSERT INTO seasons(name,start_date,end_date,active) VALUES($1,$2,$3,$4) RETURNING *",
    [name, req.body.startDate || null, req.body.endDate || null, Boolean(req.body.active)]
  );
  res.status(201).json({ season: rows[0] });
});

app.post("/api/admin/divisions", requireRoles(ROLE.NCSF), async (req, res) => {
  const { rows } = await pool.query(
    "INSERT INTO divisions(season_id,name,sort_order) VALUES($1,$2,$3) RETURNING *",
    [Number(req.body.seasonId), String(req.body.name || "").trim(), Number(req.body.sortOrder || 0)]
  );
  res.status(201).json({ division: rows[0] });
});

app.post("/api/admin/clubs", requireRoles(ROLE.NCSF), async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Club name is required." });
  const { rows } = await pool.query(
    "INSERT INTO clubs(name,short_name) VALUES($1,$2) RETURNING *",
    [name, String(req.body.shortName || "").trim() || null]
  );
  res.status(201).json({ club: rows[0] });
});

app.post("/api/admin/teams", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const clubId = req.user.role === ROLE.CLUB ? req.user.club_id : Number(req.body.clubId);
  const name = String(req.body.name || "").trim();
  if (!clubId || !name) return res.status(400).json({ error: "Club and team name are required." });
  const { rows } = await pool.query(
    "INSERT INTO teams(club_id,division_id,name,short_name) VALUES($1,$2,$3,$4) RETURNING *",
    [clubId, req.body.divisionId ? Number(req.body.divisionId) : null, name, String(req.body.shortName || "").trim() || null]
  );
  res.status(201).json({ team: rows[0] });
});

app.post("/api/admin/players", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const clubId = req.user.role === ROLE.CLUB ? req.user.club_id : Number(req.body.clubId);
  const teamId = req.body.teamId ? Number(req.body.teamId) : null;
  if (teamId && !(await teamBelongsToClub(teamId, clubId))) return res.status(400).json({ error: "That team does not belong to the selected club." });

  const firstName = String(req.body.firstName || "").trim();
  const lastName = String(req.body.lastName || "").trim();
  if (!clubId || !firstName || !lastName) return res.status(400).json({ error: "Club, first name and last name are required." });

  const suppliedNumber = String(req.body.ncsfNumber || "").trim();
  const ncsfNumber = suppliedNumber || await generateNcsfNumber();
  const { rows } = await pool.query(`
    INSERT INTO players(club_id,team_id,ncsf_number,first_name,last_name)
    VALUES($1,$2,$3,$4,$5) RETURNING *
  `, [clubId, teamId, ncsfNumber, firstName, lastName]);
  res.status(201).json({ player: rows[0] });
});

app.patch("/api/admin/players/:id", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const playerId = Number(req.params.id);
  const { rows: existingRows } = await pool.query("SELECT * FROM players WHERE id=$1", [playerId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: "Player not found." });
  if (req.user.role === ROLE.CLUB && existing.club_id !== req.user.club_id) return res.status(403).json({ error: "Not your club." });

  const teamId = req.body.teamId === undefined
    ? existing.team_id
    : (req.body.teamId === null || req.body.teamId === "" ? null : Number(req.body.teamId));
  if (teamId && !(await teamBelongsToClub(teamId, existing.club_id))) return res.status(400).json({ error: "Team must belong to the player's club." });

  const { rows } = await pool.query(`
    UPDATE players
    SET team_id=$2,
        ncsf_number=COALESCE($3,ncsf_number),
        active=COALESCE($4,active),
        suspended=COALESCE($5,suspended)
    WHERE id=$1 RETURNING *
  `, [
    playerId,
    teamId,
    req.body.ncsfNumber === undefined ? null : String(req.body.ncsfNumber || "").trim(),
    req.body.active === undefined ? null : Boolean(req.body.active),
    req.body.suspended === undefined ? null : Boolean(req.body.suspended)
  ]);
  res.json({ player: rows[0] });
});

app.post("/api/admin/users", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const email = cleanEmail(req.body.email);
  const displayName = String(req.body.displayName || "").trim();
  const password = String(req.body.password || "");
  let role = String(req.body.role || ROLE.TEAM);
  let clubId = req.body.clubId ? Number(req.body.clubId) : null;
  let teamId = req.body.teamId ? Number(req.body.teamId) : null;

  if (req.user.role === ROLE.CLUB) {
    role = ROLE.TEAM;
    clubId = req.user.club_id;
    if (!teamId || !(await teamBelongsToClub(teamId, clubId))) return res.status(400).json({ error: "Choose one of your club teams." });
  }
  if (![ROLE.NCSF, ROLE.CLUB, ROLE.TEAM].includes(role)) return res.status(400).json({ error: "Invalid role." });
  if (!email || !displayName || password.length < 8) return res.status(400).json({ error: "Name, email and an 8+ character password are required." });
  if (role === ROLE.TEAM && (!teamId || !clubId)) return res.status(400).json({ error: "Team admins need a club and team." });
  if (role === ROLE.CLUB && !clubId) return res.status(400).json({ error: "Club admins need a club." });
  if (teamId && clubId && !(await teamBelongsToClub(teamId, clubId))) return res.status(400).json({ error: "Team does not belong to that club." });

  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(`
    INSERT INTO users(email,password_hash,display_name,role,club_id,team_id)
    VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id,email,display_name,role,club_id,team_id,active
  `, [email, hash, displayName, role, clubId, teamId]);
  res.status(201).json({ user: safeUser(rows[0]) });
});

app.post("/api/admin/fixtures", requireRoles(ROLE.NCSF), async (req, res) => {
  const divisionId = Number(req.body.divisionId);
  const homeTeamId = Number(req.body.homeTeamId);
  const awayTeamId = Number(req.body.awayTeamId);
  const valid = await pool.query(
    "SELECT COUNT(*)::int count FROM teams WHERE id IN ($1,$2) AND division_id=$3",
    [homeTeamId, awayTeamId, divisionId]
  );
  if (valid.rows[0].count !== 2) return res.status(400).json({ error: "Both teams must belong to the selected division." });

  const { rows } = await pool.query(`
    INSERT INTO fixtures(division_id,round_no,fixture_date,venue,home_team_id,away_team_id)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *
  `, [
    divisionId,
    Number(req.body.roundNo || 1),
    req.body.fixtureDate || null,
    String(req.body.venue || "").trim() || null,
    homeTeamId,
    awayTeamId
  ]);
  res.status(201).json({ fixture: rows[0] });
});

app.patch("/api/admin/fixtures/:id", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });

  const roundNo = req.body.roundNo === undefined ? fixture.round_no : Number(req.body.roundNo);
  const fixtureDate = req.body.fixtureDate === undefined ? fixture.fixture_date : (req.body.fixtureDate || null);
  const venue = req.body.venue === undefined ? fixture.venue : (String(req.body.venue || "").trim() || null);
  const streamUrl = req.body.streamUrl === undefined ? fixture.stream_url : (String(req.body.streamUrl || "").trim() || null);
  const streamTitle = req.body.streamTitle === undefined ? fixture.stream_title : (String(req.body.streamTitle || "").trim() || null);
  const streamActive = req.body.streamActive === undefined ? Boolean(fixture.stream_active) : Boolean(req.body.streamActive);
  if (!Number.isInteger(roundNo) || roundNo < 1) return res.status(400).json({ error: "Round number must be 1 or higher." });
  if (streamActive && !streamUrl) return res.status(400).json({ error: "A stream URL is required before going live." });

  const { rows } = await pool.query(`
    UPDATE fixtures
    SET round_no=$2, fixture_date=$3, venue=$4,
        stream_url=$5,stream_title=$6,stream_active=$7
    WHERE id=$1
    RETURNING *
  `, [fixtureId, roundNo, fixtureDate, venue, streamUrl, streamTitle, streamActive]);
  await audit(req.user.id, fixtureId, "FIXTURE_UPDATED", { roundNo, fixtureDate, venue, streamUrl, streamTitle, streamActive });
  res.json({ fixture: rows[0] });
});

app.post("/api/admin/fixtures/:id/postpone", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (fixture.status === "APPROVED") return res.status(409).json({ error: "Approved fixtures cannot be postponed." });
  await pool.query("UPDATE fixtures SET status='POSTPONED' WHERE id=$1", [fixtureId]);
  await audit(req.user.id, fixtureId, "FIXTURE_POSTPONED", {});
  res.json(await fixturePayload(await fixtureById(fixtureId)));
});

app.post("/api/admin/fixtures/:id/restore", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (fixture.status !== "POSTPONED") return res.status(409).json({ error: "Only postponed fixtures can be restored." });
  const { rows } = await pool.query("SELECT COUNT(*)::int count FROM frames WHERE fixture_id=$1 AND winner_side IS NOT NULL", [fixtureId]);
  const status = rows[0].count > 0 ? "IN_PROGRESS" : "SCHEDULED";
  await pool.query("UPDATE fixtures SET status=$2 WHERE id=$1", [fixtureId, status]);
  await audit(req.user.id, fixtureId, "FIXTURE_RESTORED", { status });
  res.json(await fixturePayload(await fixtureById(fixtureId)));
});

app.delete("/api/admin/fixtures/:id", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (!["SCHEDULED","POSTPONED"].includes(fixture.status)) return res.status(409).json({ error: "Only unplayed scheduled or postponed fixtures can be deleted." });
  const { rows } = await pool.query("SELECT COUNT(*)::int count FROM frames WHERE fixture_id=$1 AND winner_side IS NOT NULL", [fixtureId]);
  if (rows[0].count > 0) return res.status(409).json({ error: "A fixture with scored frames cannot be deleted." });
  await pool.query("DELETE FROM fixtures WHERE id=$1", [fixtureId]);
  res.json({ ok: true });
});

app.patch("/api/admin/users/:id", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const userId = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: "User not found." });

  if (req.user.role === ROLE.CLUB) {
    if (target.role !== ROLE.TEAM || target.club_id !== req.user.club_id) {
      return res.status(403).json({ error: "Club admins can only manage team logins for their own club." });
    }
  }

  const active = req.body.active === undefined ? target.active : Boolean(req.body.active);
  let passwordHash = target.password_hash;
  if (req.body.password !== undefined) {
    const password = String(req.body.password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    passwordHash = await bcrypt.hash(password, 12);
  }

  const updated = await pool.query(`
    UPDATE users SET active=$2,password_hash=$3 WHERE id=$1
    RETURNING id,email,display_name,role,club_id,team_id,active
  `, [userId, active, passwordHash]);
  res.json({ user: safeUser(updated.rows[0]) });
});

app.post("/api/admin/divisions/:id/generate-home-away", requireRoles(ROLE.NCSF), async (req, res) => {
  const divisionId = Number(req.params.id);
  const { rows: existing } = await pool.query("SELECT COUNT(*)::int count FROM fixtures WHERE division_id=$1", [divisionId]);
  if (existing[0].count > 0 && !req.body.force) {
    return res.status(409).json({ error: "This division already has fixtures. Send force=true only if you intentionally want to add another schedule." });
  }
  const { rows: teams } = await pool.query("SELECT id FROM teams WHERE division_id=$1 AND active=TRUE ORDER BY id", [divisionId]);
  if (teams.length < 2) return res.status(400).json({ error: "At least two teams are required." });

  let ids = teams.map(t => t.id);
  if (ids.length % 2) ids.push(null);
  const n = ids.length;
  const rounds = n - 1;
  const firstDate = req.body.firstDate ? new Date(req.body.firstDate) : new Date();
  const dayMs = 7 * 24 * 60 * 60 * 1000;

  const created = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let rotating = [...ids];
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n / 2; i++) {
        const a = rotating[i];
        const b = rotating[n - 1 - i];
        if (!a || !b) continue;
        const home = r % 2 === 0 ? a : b;
        const away = r % 2 === 0 ? b : a;
        const d1 = new Date(firstDate.getTime() + r * dayMs);
        const q1 = await client.query(`
          INSERT INTO fixtures(division_id,round_no,fixture_date,home_team_id,away_team_id)
          VALUES($1,$2,$3,$4,$5) RETURNING id
        `, [divisionId, r + 1, d1.toISOString(), home, away]);
        created.push(q1.rows[0].id);

        const d2 = new Date(firstDate.getTime() + (r + rounds) * dayMs);
        const q2 = await client.query(`
          INSERT INTO fixtures(division_id,round_no,fixture_date,home_team_id,away_team_id)
          VALUES($1,$2,$3,$4,$5) RETURNING id
        `, [divisionId, r + 1 + rounds, d2.toISOString(), away, home]);
        created.push(q2.rows[0].id);
      }
      rotating = [rotating[0], rotating[n - 1], ...rotating.slice(1, n - 1)];
    }
    await client.query("COMMIT");
    res.status(201).json({ created: created.length, fixtureIds: created });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.put("/api/fixtures/:id/lineup", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (["SUBMITTED","CONFIRMED","APPROVED"].includes(fixture.status) && user.role !== ROLE.NCSF) return res.status(409).json({ error: "This score sheet is locked." });

  const side = String(req.body.side || "").toUpperCase();
  if (!["HOME","AWAY"].includes(side)) return res.status(400).json({ error: "Invalid side." });
  const userSide = sideForUser(user, fixture);
  if (user.role === ROLE.TEAM && userSide !== side) return res.status(403).json({ error: "Team admins can only set their own lineup." });
  if (user.role === ROLE.CLUB && userSide !== side) return res.status(403).json({ error: "Club admins can only set their club lineup." });

  const playerIds = Array.isArray(req.body.playerIds) ? req.body.playerIds.map(Number) : [];
  const reserveIds = Array.isArray(req.body.reserveIds) ? req.body.reserveIds.map(Number).filter(Boolean) : [];
  if (playerIds.length !== 5 || new Set(playerIds).size !== 5) return res.status(400).json({ error: "Exactly five different starting players are required." });
  if (reserveIds.length > 2 || new Set(reserveIds).size !== reserveIds.length) return res.status(400).json({ error: "Choose no more than two different reserves." });
  const allSelected = [...playerIds, ...reserveIds];
  if (new Set(allSelected).size !== allSelected.length) return res.status(400).json({ error: "A player cannot be both a starter and a reserve." });
  const teamId = side === "HOME" ? fixture.home_team_id : fixture.away_team_id;
  const { rows: validRows } = await pool.query(
    "SELECT id FROM players WHERE id=ANY($1::int[]) AND team_id=$2 AND active=TRUE AND suspended=FALSE",
    [allSelected, teamId]
  );
  if (validRows.length !== allSelected.length) return res.status(400).json({ error: "All selected players must be active, eligible players from this team." });

  const { rows: scoredRows } = await pool.query("SELECT COUNT(*)::int count FROM frames WHERE fixture_id=$1 AND winner_side IS NOT NULL", [fixture.id]);
  if (scoredRows[0].count > 0) return res.status(409).json({ error: "Lineups cannot be changed after scoring starts. Use a substitution instead." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM frames WHERE fixture_id=$1", [fixture.id]);
    await client.query("DELETE FROM fixture_lineups WHERE fixture_id=$1 AND side=$2", [fixture.id, side]);
    await client.query("DELETE FROM fixture_reserves WHERE fixture_id=$1 AND side=$2", [fixture.id, side]);
    for (let i = 0; i < 5; i++) {
      await client.query(
        "INSERT INTO fixture_lineups(fixture_id,side,slot,player_id) VALUES($1,$2,$3,$4)",
        [fixture.id, side, i + 1, playerIds[i]]
      );
    }
    for (let i = 0; i < reserveIds.length; i++) {
      await client.query(
        "INSERT INTO fixture_reserves(fixture_id,side,reserve_slot,player_id) VALUES($1,$2,$3,$4)",
        [fixture.id, side, i + 1, reserveIds[i]]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await ensureFrames(fixture.id);
  await audit(user.id, fixture.id, "LINEUP_SAVED", { side, playerIds, reserveIds });
  const payload = await fixturePayload(await fixtureById(fixture.id));
  await sendLiveMatchState(fixture.id);
  res.json(payload);
});

app.post("/api/fixtures/:id/substitutions", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (["SUBMITTED","CONFIRMED","APPROVED"].includes(fixture.status) && user.role !== ROLE.NCSF) return res.status(409).json({ error: "This score sheet is locked." });

  const side = String(req.body.side || "").toUpperCase();
  const outPlayerId = Number(req.body.outPlayerId);
  const inPlayerId = Number(req.body.inPlayerId);
  const effectiveRound = Number(req.body.effectiveRound);
  if (!["HOME","AWAY"].includes(side) || !outPlayerId || !inPlayerId || effectiveRound < 1 || effectiveRound > 5) {
    return res.status(400).json({ error: "Side, players and effective round are required." });
  }
  const userSide = sideForUser(user, fixture);
  if ([ROLE.TEAM, ROLE.CLUB].includes(user.role) && userSide !== side) return res.status(403).json({ error: "You can only substitute your own side." });

  const teamId = side === "HOME" ? fixture.home_team_id : fixture.away_team_id;
  const { rows: eligible } = await pool.query(
    "SELECT id FROM players WHERE id=ANY($1::int[]) AND team_id=$2 AND active=TRUE AND suspended=FALSE",
    [[outPlayerId, inPlayerId], teamId]
  );
  if (eligible.length !== 2) return res.status(400).json({ error: "Both players must be eligible members of this team." });

  const { rows: subCountRows } = await pool.query(
    "SELECT COUNT(*)::int count FROM substitutions WHERE fixture_id=$1 AND side=$2",
    [fixture.id, side]
  );
  if (subCountRows[0].count >= 3) return res.status(409).json({ error: "A side may make up to three substitutions in this match." });

  const { rows: roundProgressRows } = await pool.query(
    `SELECT round_no, COUNT(*)::int frame_count,
            COUNT(*) FILTER (WHERE winner_side IS NOT NULL)::int completed_count
     FROM frames WHERE fixture_id=$1 GROUP BY round_no ORDER BY round_no`,
    [fixture.id]
  );
  const roundProgress = new Map(roundProgressRows.map(row=>[Number(row.round_no),row]));
  let completedRounds=0;
  for(let round=1;round<=5;round++){
    const progress=roundProgress.get(round);
    if(!progress||progress.frame_count!==5||progress.completed_count!==5)break;
    completedRounds=round;
  }
  const nextEffectiveRound=completedRounds+1;
  if(completedRounds<1||nextEffectiveRound>5){
    return res.status(409).json({error:"Substitutions can only be made after a completed round."});
  }
  const currentRound=roundProgress.get(nextEffectiveRound);
  if(currentRound?.completed_count>0){
    return res.status(409).json({error:"Finish the current round before recording a substitution."});
  }
  if(effectiveRound<nextEffectiveRound){
    return res.status(409).json({error:"The effective round must be the next round or later."});
  }

  const field = side === "HOME" ? "home_player_id" : "away_player_id";
  const { rows: rosterRows } = await pool.query(
    `SELECT player_id FROM fixture_lineups WHERE fixture_id=$1 AND side=$2
     UNION SELECT player_id FROM fixture_reserves WHERE fixture_id=$1 AND side=$2`,
    [fixture.id, side]
  );
  const rosterIds=new Set(rosterRows.map(row=>Number(row.player_id)));
  if(!rosterIds.has(outPlayerId)||!rosterIds.has(inPlayerId)){
    return res.status(400).json({error:"Both players must be on this side's match roster."});
  }
  const { rows: roundPlayers } = await pool.query(
    `SELECT DISTINCT ${field} player_id FROM frames WHERE fixture_id=$1 AND round_no=$2`,
    [fixture.id, effectiveRound]
  );
  const activeIds=new Set(roundPlayers.map(row=>Number(row.player_id)));
  if(!activeIds.has(outPlayerId)){
    return res.status(400).json({error:"Player Out must be active in the selected effective round."});
  }
  if(activeIds.has(inPlayerId)){
    return res.status(400).json({error:"Player In is already active in the selected effective round."});
  }
  const { rows: alreadyScored } = await pool.query(
    `SELECT COUNT(*)::int count FROM frames WHERE fixture_id=$1 AND round_no >= $2 AND winner_side IS NOT NULL`,
    [fixture.id, effectiveRound]
  );
  if (alreadyScored[0].count > 0) return res.status(409).json({ error: "A substitution cannot rewrite rounds that are already scored." });

  await pool.query(
    "INSERT INTO substitutions(fixture_id,side,out_player_id,in_player_id,effective_round,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [fixture.id, side, outPlayerId, inPlayerId, effectiveRound, user.id]
  );
  await pool.query(
    `UPDATE frames SET ${field}=$1, updated_by=$2, updated_at=NOW()
     WHERE fixture_id=$3 AND round_no >= $4 AND ${field}=$5 AND winner_side IS NULL`,
    [inPlayerId, user.id, fixture.id, effectiveRound, outPlayerId]
  );
  await audit(user.id, fixture.id, "SUBSTITUTION", { side, outPlayerId, inPlayerId, effectiveRound });
  const payload = await fixturePayload(await fixtureById(fixture.id));
  await sendLiveMatchState(fixture.id);
  res.json(payload);
});

app.put("/api/fixtures/:id/frames/:frameId", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (["SUBMITTED","CONFIRMED","APPROVED"].includes(fixture.status) && user.role !== ROLE.NCSF) return res.status(409).json({ error: "This score sheet is locked." });

  const winnerSide = req.body.winnerSide === null ? null : String(req.body.winnerSide || "").toUpperCase();
  if (winnerSide !== null && !["HOME","AWAY"].includes(winnerSide)) return res.status(400).json({ error: "Winner must be HOME or AWAY." });

  const { rows: frameRows } = await pool.query("SELECT * FROM frames WHERE id=$1 AND fixture_id=$2", [Number(req.params.frameId), fixture.id]);
  const frame = frameRows[0];
  if (!frame) return res.status(404).json({ error: "Frame not found." });
  const winnerPlayerId = winnerSide === "HOME" ? frame.home_player_id : winnerSide === "AWAY" ? frame.away_player_id : null;

  await pool.query(
    "UPDATE frames SET winner_side=$1,winner_player_id=$2,updated_by=$3,updated_at=NOW() WHERE id=$4",
    [winnerSide, winnerPlayerId, user.id, frame.id]
  );
  if (fixture.status === "SCHEDULED") await pool.query("UPDATE fixtures SET status='IN_PROGRESS' WHERE id=$1", [fixture.id]);
  await audit(user.id, fixture.id, "FRAME_RESULT", { frameId: frame.id, round: frame.round_no, board: frame.board_no, winnerSide });
  await syncDerivedFixtureExtras(fixture.id);
  const payload = await fixturePayload(await fixtureById(fixture.id));
  await sendLiveMatchState(fixture.id);
  res.json(payload);
});

app.patch("/api/fixtures/:id/extras", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (fixture.status === "APPROVED" && user.role !== ROLE.NCSF) return res.status(409).json({ error: "Approved fixtures are locked." });

  const idsInput = Array.isArray(req.body.breakRunPlayerIds)
    ? req.body.breakRunPlayerIds
    : req.body.breakRunPlayerIds
      ? [req.body.breakRunPlayerIds]
      : req.body.breakRunPlayerId
        ? [req.body.breakRunPlayerId]
        : [];
  const breakRunPlayerIds = [...new Set(idsInput.map(Number).filter(Number.isInteger))];

  if (breakRunPlayerIds.length) {
    const { rows } = await pool.query(`
      SELECT DISTINCT p.id
      FROM players p
      JOIN teams t ON t.id=p.team_id
      WHERE p.id = ANY($1::int[])
        AND t.id IN ($2,$3)
    `, [breakRunPlayerIds, fixture.home_team_id, fixture.away_team_id]);
    if (rows.length !== breakRunPlayerIds.length) {
      return res.status(400).json({ error: "Break & Run players must belong to one of the participating teams." });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM fixture_break_runs WHERE fixture_id=$1", [fixture.id]);
    for (const playerId of breakRunPlayerIds) {
      await client.query(
        "INSERT INTO fixture_break_runs(fixture_id,player_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [fixture.id, playerId]
      );
    }

    await client.query(`
      UPDATE fixtures SET
        break_run_player_id=$2,
        rack_run_player_id=$3,
        home_captain_id=$4,
        away_captain_id=$5,
        notes=$6
      WHERE id=$1
    `, [
      fixture.id,
      breakRunPlayerIds[0] || null,
      req.body.rackRunPlayerId ? Number(req.body.rackRunPlayerId) : null,
      req.body.homeCaptainId ? Number(req.body.homeCaptainId) : null,
      req.body.awayCaptainId ? Number(req.body.awayCaptainId) : null,
      String(req.body.notes || "").trim() || null
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await syncDerivedFixtureExtras(fixture.id);
  await audit(user.id, fixture.id, "MATCH_EXTRAS_UPDATED", {
    breakRunPlayerIds,
    rackRunPlayerId: req.body.rackRunPlayerId || null,
    homeCaptainId: req.body.homeCaptainId || null,
    awayCaptainId: req.body.awayCaptainId || null
  });
  res.json(await fixturePayload(await fixtureById(fixture.id)));
});

app.post("/api/fixtures/:id/upload", requireAuth, upload.single("scoresheet"), async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (!req.file) return res.status(400).json({ error: "Choose a score sheet image or PDF." });

  const { rows } = await pool.query(`
    INSERT INTO fixture_attachments(fixture_id,filename,mimetype,file_data,uploaded_by)
    VALUES($1,$2,$3,$4,$5)
    RETURNING id,kind,filename,mimetype,created_at
  `, [fixture.id, req.file.originalname, req.file.mimetype, req.file.buffer, user.id]);
  await audit(user.id, fixture.id, "SIGNED_SCORESHEET_UPLOADED", { attachmentId: rows[0].id, filename: rows[0].filename });
  res.status(201).json({ attachment: rows[0] });
});

app.post("/api/fixtures/:id/submit", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });

  const submittingSide = sideForUser(user, fixture);
  if (!["HOME","AWAY"].includes(submittingSide)) {
    return res.status(403).json({ error: "A participating team or its club admin must submit the result." });
  }
  if (!["SCHEDULED","IN_PROGRESS"].includes(fixture.status)) {
    return res.status(409).json({ error: "This result has already been submitted." });
  }

  await syncDerivedFixtureExtras(fixture.id);
  const payload = await fixturePayload(await fixtureById(fixture.id));
  if (payload.frames.length !== 25 || payload.totals.completed !== 25) return res.status(409).json({ error: "All 25 frames must be completed before submission." });
  if (payload.lineups.length !== 10) return res.status(409).json({ error: "Both five-player lineups are required." });

  const homeConfirmedBy = submittingSide === "HOME" ? user.id : null;
  const awayConfirmedBy = submittingSide === "AWAY" ? user.id : null;
  await pool.query(
    `UPDATE fixtures
       SET status='SUBMITTED',
           submitted_by=$2,
           submitted_side=$3,
           confirmed_by=NULL,
           home_confirmed_by=$4,
           away_confirmed_by=$5
       WHERE id=$1`,
    [fixture.id, user.id, submittingSide, homeConfirmedBy, awayConfirmedBy]
  );
  await audit(user.id, fixture.id, "MATCH_SUBMITTED", { side: submittingSide, totals: payload.totals });
  res.json(await fixturePayload(await fixtureById(fixture.id)));
});

app.post("/api/fixtures/:id/confirm", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (fixture.status !== "SUBMITTED") return res.status(409).json({ error: "The result is not waiting for opponent confirmation." });

  const confirmingSide = sideForUser(user, fixture);
  if (!["HOME","AWAY"].includes(confirmingSide)) {
    return res.status(403).json({ error: "Only the opposing participating team can confirm the submitted result." });
  }
  if (!fixture.submitted_side) return res.status(409).json({ error: "The submitting team could not be identified. Ask NCSF administration to review this fixture." });
  if (confirmingSide === fixture.submitted_side) {
    return res.status(403).json({ error: "The team that submitted the result cannot confirm its own submission." });
  }

  const homeConfirmedBy = confirmingSide === "HOME" ? user.id : fixture.home_confirmed_by;
  const awayConfirmedBy = confirmingSide === "AWAY" ? user.id : fixture.away_confirmed_by;
  await pool.query(
    `UPDATE fixtures
       SET confirmed_by=$2,
           home_confirmed_by=$3,
           away_confirmed_by=$4,
           status='CONFIRMED'
       WHERE id=$1`,
    [fixture.id, user.id, homeConfirmedBy, awayConfirmedBy]
  );
  await audit(user.id, fixture.id, "MATCH_CONFIRMED", { side: confirmingSide, submittedSide: fixture.submitted_side });
  res.json(await fixturePayload(await fixtureById(fixture.id)));
});

app.post("/api/fixtures/:id/approve", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if (fixture.status !== "CONFIRMED") return res.status(409).json({ error: "The opposing team must confirm the submitted result before NCSF approval." });

  const payload = await fixturePayload(fixture);
  if (payload.totals.completed !== 25) return res.status(409).json({ error: "All 25 frames must be scored." });

  await pool.query(
    "UPDATE fixtures SET status='APPROVED',approved_by=$2,approved_at=NOW() WHERE id=$1",
    [fixture.id, req.user.id]
  );
  await audit(req.user.id, fixture.id, "MATCH_APPROVED", { totals: payload.totals });
  res.json(await fixturePayload(await fixtureById(fixture.id)));
});

app.get("/api/fixtures/:id/audit", requireRoles(ROLE.NCSF, ROLE.CLUB), async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  if (!fixture || !canManageFixture(req.user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  const { rows } = await pool.query(`
    SELECT a.id,a.action,a.detail,a.created_at,u.display_name
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.fixture_id=$1
    ORDER BY a.created_at DESC
  `, [fixture.id]);
  res.json({ audit: rows });
});

const pageRoutes = {
  "/fixtures": "fixtures.html",
  "/results": "results.html",
  "/teams": "teams.html",
  "/players": "players.html",
  "/live": "live.html",
  "/broadcast": "broadcast.html",
  "/news": "news.html",
  "/opportunities": "opportunities.html",
  "/rankings": "rankings.html",
  "/admin": "admin.html",
  "/club-admin": "club-admin.html",
  "/team": "team.html",
  "/scoresheet": "scoresheet.html"
};
for (const [route, file] of Object.entries(pageRoutes)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, "public", file)));
}

let cachedNcsfLogoJpeg = null;
function getNcsfLogoJpeg() {
  if (cachedNcsfLogoJpeg) return cachedNcsfLogoJpeg;
  const svg = fs.readFileSync(path.join(__dirname, "public", "ncsf-logo.svg"), "utf8");
  const match = svg.match(/data:image\/jpeg;base64,([^"']+)/i);
  if (!match) throw new Error("Embedded NCSF logo image is missing.");
  cachedNcsfLogoJpeg = Buffer.from(match[1], "base64");
  return cachedNcsfLogoJpeg;
}

app.get(["/ncsf-logo.jpg", "/favicon.ico"], (_req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.type("jpg").send(getNcsfLogoJpeg());
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));


const liveWss = new WebSocketServer({ server: httpServer, path: "/live-socket" });

function liveStateFor(fixtureId) {
  const id = Number(fixtureId);
  let state = liveStreams.get(id);
  if (!state) {
    state = {
      fixtureId: id,
      publisher: null,
      publisherGraceTimer: null,
      viewers: new Map(),
      chatClients: new Set(),
      startedAt: null
    };
    liveStreams.set(id, state);
  }
  return state;
}

function sendLiveControl(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function updatePublisherViewerCount(state) {
  const viewers = [...state.viewers.entries()].map(([id, viewer]) => ({
    id,
    name: String(viewer.viewerName || "Viewer")
  }));
  sendLiveControl(state.publisher, { type: "viewerCount", count: viewers.length, viewers });
}

function relayToViewer(state, viewerId, payload) {
  const viewer = state.viewers.get(String(viewerId || ""));
  if (viewer) sendLiveControl(viewer, payload);
}

async function buildLiveMatchState(fixtureId) {
  const fixture = await fixtureById(Number(fixtureId));
  if (!fixture) return null;
  const payload = await fixturePayload(fixture);
  const frames = payload.frames || [];
  const currentIndex = frames.findIndex(fr => !fr.winner_side);
  const current = currentIndex >= 0 ? frames[currentIndex] : null;
  const next = currentIndex >= 0 ? (frames[currentIndex + 1] || null) : null;
  const previous = currentIndex > 0
    ? frames[currentIndex - 1]
    : (currentIndex < 0 && frames.length ? frames[frames.length - 1] : null);

  const completed = payload.totals.completed;
  const completedRound = completed > 0 && completed % 5 === 0 ? completed / 5 : null;
  let roundSummary = null;
  if (completedRound) {
    const roundFrames = frames.filter(fr => Number(fr.round_no) === completedRound && fr.winner_side);
    const progressiveFrames = frames.filter(fr => Number(fr.round_no) <= completedRound && fr.winner_side);
    roundSummary = {
      roundNo: completedRound,
      home: roundFrames.filter(fr => fr.winner_side === "HOME").length,
      away: roundFrames.filter(fr => fr.winner_side === "AWAY").length,
      progressiveHome: progressiveFrames.filter(fr => fr.winner_side === "HOME").length,
      progressiveAway: progressiveFrames.filter(fr => fr.winner_side === "AWAY").length
    };
  }

  const frameView = fr => fr ? ({
    id: fr.id,
    roundNo: Number(fr.round_no),
    boardNo: Number(fr.board_no),
    homePlayerId: Number(fr.home_player_id),
    awayPlayerId: Number(fr.away_player_id),
    homePlayerName: fr.home_player_name,
    awayPlayerName: fr.away_player_name,
    winnerSide: fr.winner_side || null,
    breakLabel: fr.break_label || null,
    breakSide: fr.break_side || null,
    breakSlot: fr.break_slot || null
  }) : null;

  return {
    fixtureId: fixture.id,
    homeTeamName: fixture.home_team_name,
    awayTeamName: fixture.away_team_name,
    lineupsReady: payload.lineups.length === 10 && frames.length === 25,
    completed,
    homeScore: payload.totals.home,
    awayScore: payload.totals.away,
    remaining: payload.totals.remaining,
    roundSummary,
    current: frameView(current),
    next: frameView(next),
    previous: frameView(previous),
    final: payload.totals.completed === 25
  };
}

async function sendLiveMatchState(fixtureId, target = null) {
  try {
    const matchState = await buildLiveMatchState(fixtureId);
    if (!matchState) return;
    const payload = { type: "match-state", match: matchState };

    if (target) {
      sendLiveControl(target, payload);
      return;
    }

    const state = liveStateFor(fixtureId);
    sendLiveControl(state.publisher, payload);
    for (const viewer of state.viewers.values()) sendLiveControl(viewer, payload);
  } catch (error) {
    console.error("Failed to send live match state:", error);
  }
}

liveWss.on("connection", async (ws, req) => {
  try {
    const u = new URL(req.url, "http://localhost");
    const fixtureId = Number(u.searchParams.get("fixtureId") || 0);
    const mode = String(u.searchParams.get("mode") || "viewer");
    if (!fixtureId) {
      ws.close(4400, "Fixture required");
      return;
    }

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const state = liveStateFor(fixtureId);

    if (mode === "chat") {
      const fixture = await fixtureById(fixtureId);
      if (!fixture || !fixture.stream_active) {
        sendLiveControl(ws, { type: "chat-offline" });
        ws.close(4404, "Chat offline");
        return;
      }
      state.chatClients.add(ws);
      sendLiveControl(ws, { type: "chat-ready", fixtureId });
      ws.on("close", () => state.chatClients.delete(ws));
      return;
    }

    if (mode === "publisher") {
      const token = u.searchParams.get("token");
      const tokenData = consumeBroadcastToken(token, fixtureId);
      if (!tokenData) {
        ws.close(4401, "Invalid broadcast token");
        return;
      }
      if (state.publisher && state.publisher.readyState === WebSocket.OPEN) {
        ws.close(4409, "This fixture already has a live broadcaster");
        return;
      }

      const fixture = await fixtureById(fixtureId);
      if (!fixture || fixture.status === "APPROVED") {
        ws.close(4403, "Fixture cannot be broadcast");
        return;
      }

      if (state.publisherGraceTimer) {
        clearTimeout(state.publisherGraceTimer);
        state.publisherGraceTimer = null;
      }
      state.publisher = ws;
      if (!state.startedAt) state.startedAt = Date.now();

      await pool.query(
        "UPDATE fixtures SET stream_url=$2,stream_title=$3,stream_active=TRUE WHERE id=$1",
        [fixtureId, "internal://fixture/" + fixtureId, fixture.home_team_name + " vs " + fixture.away_team_name]
      );

      sendLiveControl(ws, { type: "ready", fixtureId, viewerCount: state.viewers.size });
      for (const [viewerId, viewer] of state.viewers) {
        sendLiveControl(viewer, { type: "waiting" });
        sendLiveControl(ws, { type: "viewer-joined", viewerId, viewerName: viewer.viewerName || "Viewer" });
      }
      updatePublisherViewerCount(state);
      await sendLiveMatchState(fixtureId, ws);

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (msg.type === "publisher-stop") {
          ws.intentionalStop = true;
        } else if (msg.type === "webrtc-offer" && msg.viewerId && msg.sdp) {
          relayToViewer(state, msg.viewerId, { type: "webrtc-offer", sdp: msg.sdp });
        } else if (msg.type === "webrtc-ice" && msg.viewerId && msg.candidate) {
          relayToViewer(state, msg.viewerId, { type: "webrtc-ice", candidate: msg.candidate });
        }
      });

      ws.on("close", async () => {
        if (state.publisher !== ws) return;
        state.publisher = null;

        if (ws.intentionalStop) {
          if (state.publisherGraceTimer) {
            clearTimeout(state.publisherGraceTimer);
            state.publisherGraceTimer = null;
          }
          for (const viewer of state.viewers.values()) {
            sendLiveControl(viewer, { type: "ended" });
          }
          try {
            await pool.query(
              "UPDATE fixtures SET stream_active=FALSE,stream_url=NULL WHERE id=$1 AND stream_url=$2",
              [fixtureId, "internal://fixture/" + fixtureId]
            );
          } catch (error) {
            console.error("Failed to clear intentionally stopped live stream:", error);
          }
          return;
        }

        for (const viewer of state.viewers.values()) {
          sendLiveControl(viewer, { type: "reconnecting" });
        }

        if (state.publisherGraceTimer) clearTimeout(state.publisherGraceTimer);
        state.publisherGraceTimer = setTimeout(async () => {
          state.publisherGraceTimer = null;
          if (state.publisher && state.publisher.readyState === WebSocket.OPEN) return;

          for (const viewer of state.viewers.values()) {
            sendLiveControl(viewer, { type: "ended" });
          }

          try {
            await pool.query(
              "UPDATE fixtures SET stream_active=FALSE,stream_url=NULL WHERE id=$1 AND stream_url=$2",
              [fixtureId, "internal://fixture/" + fixtureId]
            );
          } catch (error) {
            console.error("Failed to clear live stream after reconnect grace:", error);
          }
        }, 60000);
      });
      return;
    }

    const fixture = await fixtureById(fixtureId);
    const internalLive = fixture && fixture.stream_active && String(fixture.stream_url || "").startsWith("internal://");
    if (!internalLive && !(state.publisher && state.publisher.readyState === WebSocket.OPEN)) {
      sendLiveControl(ws, { type: "offline" });
      ws.close(4404, "Stream offline");
      return;
    }

    const viewerId = crypto.randomBytes(10).toString("hex");
    const viewerName = String(u.searchParams.get("viewerName") || "Guest viewer")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 60) || "Guest viewer";
    ws.viewerId = viewerId;
    ws.viewerName = viewerName;
    state.viewers.set(viewerId, ws);
    sendLiveControl(ws, { type: "viewer-ready", viewerId, startedAt: state.startedAt });
    await sendLiveMatchState(fixtureId, ws);
    sendLiveControl(state.publisher, { type: "viewer-joined", viewerId, viewerName });
    updatePublisherViewerCount(state);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "webrtc-answer" && msg.sdp) {
        sendLiveControl(state.publisher, { type: "webrtc-answer", viewerId, sdp: msg.sdp });
      } else if (msg.type === "webrtc-ice" && msg.candidate) {
        sendLiveControl(state.publisher, { type: "webrtc-ice", viewerId, candidate: msg.candidate });
      }
    });

    ws.on("close", () => {
      state.viewers.delete(viewerId);
      sendLiveControl(state.publisher, { type: "viewer-left", viewerId, viewerName: ws.viewerName || "Viewer" });
      updatePublisherViewerCount(state);
    });
  } catch (error) {
    console.error("Live socket error:", error);
    try { ws.close(1011, "Live stream error"); } catch {}
  }
});

const liveHeartbeat = setInterval(() => {
  for (const ws of liveWss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
liveHeartbeat.unref();

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.code === "23505") return res.status(409).json({ error: "That record already exists." });
  if (err.code === "23503") return res.status(400).json({ error: "This item is linked to another record and cannot be used that way." });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || "Unexpected server error." });
});

initDatabase()
  .then(seedOfficialCoastalRosters)
  .then(assignOfficialNcsfNumbers)
  .then(setupCentralDivisionAndSchedule)
  .then(correctAtomic5AndImportCoastalSchedule)
  .then(() => httpServer.listen(port, () => console.log(`NCSF League Manager listening on port ${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
