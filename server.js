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
      "connect-src": ["'self'"],
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
  const [{ rows: lineups }, { rows: reserves }, { rows: frames }, { rows: subs }, { rows: attachments }] = await Promise.all([
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
    `, [fixture.id])
  ]);

  const scored = frames.filter(f => f.winner_side);
  const homeFrames = scored.filter(f => f.winner_side === "HOME").length;
  const awayFrames = scored.filter(f => f.winner_side === "AWAY").length;

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
      playerOfMatchId: fixture.player_of_match_id,
      breakRunPlayerId: fixture.break_run_player_id,
      rackRunPlayerId: fixture.rack_run_player_id,
      homeCaptainId: fixture.home_captain_id,
      awayCaptainId: fixture.away_captain_id,
      bonusPoints: fixture.bonus_points,
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
  doc.fillColor(opts.color || "#111111")
    .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(opts.size || 6.2)
    .text(String(text ?? ""), x + 2.5, y + 2.2, {
      width: Math.max(1, w - 5),
      height: Math.max(1, h - 4),
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
    layout: "landscape",
    margin: 16,
    autoFirstPage: true,
    info: { Title: `NCSF ${f.homeTeamName} vs ${f.awayTeamName}` }
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="NCSF-${String(f.homeTeamName).replace(/[^a-z0-9]+/gi,"-")}-vs-${String(f.awayTeamName).replace(/[^a-z0-9]+/gi,"-")}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  const W = doc.page.width;
  const left = 16;
  const usable = W - 32;

  try {
    doc.image(getNcsfLogoJpeg(), left, 14, { fit: [38, 38], align: "center", valign: "center" });
  } catch (_e) {}

  doc.fillColor("#0b223f").font("Helvetica-Bold").fontSize(13).text("NAMIBIA CUE SPORTS FEDERATION", 60, 15, { width: 410 });
  doc.fontSize(9).fillColor("#222").text("Blackball League Scoresheet", 60, 32, { width: 300 });
  doc.font("Helvetica").fontSize(6.5).fillColor("#5f6874")
    .text(`${f.seasonName} - ${f.divisionName} - Round ${f.roundNo}`, 60, 45, { width: 350 });

  const d = f.fixtureDate ? new Date(f.fixtureDate) : null;
  const dateText = d ? d.toLocaleDateString("en-GB", { timeZone: "Africa/Windhoek" }) : "TBA";
  const timeText = d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Windhoek" }) : "TBA";
  const metaX = W - 255;
  const meta = [["DATE", dateText], ["TIME", timeText], ["VENUE", f.venue || "TBA"]];
  meta.forEach((m, i) => {
    const x = metaX + i * 80;
    drawCell(doc, x, 15, 76, 30, m[1], { size: 7, bold: true, align: "center", fill: "#f3f5f7" });
    doc.font("Helvetica-Bold").fontSize(4.8).fillColor("#687280").text(m[0], x + 2, 17, { width: 72, align: "center" });
  });

  const heroY = 60;
  const heroH = 42;
  drawCell(doc, left, heroY, usable, heroH, "", { fill: "#eef2f6", stroke: "#0b223f", lineWidth: 0.9 });
  doc.fillColor("#5c6775").font("Helvetica-Bold").fontSize(5).text("HOME", left + 10, heroY + 7);
  doc.fillColor("#0b223f").fontSize(12).text(f.homeTeamName, left + 10, heroY + 17, { width: 265, ellipsis: true });
  doc.fillColor("#5c6775").fontSize(5).text("AWAY", W - 275, heroY + 7, { width: 250, align: "right" });
  doc.fillColor("#0b223f").fontSize(12).text(f.awayTeamName, W - 275, heroY + 17, { width: 250, align: "right", ellipsis: true });
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b223f")
    .text(`${t.home}  -  ${t.away}`, W / 2 - 60, heroY + 11, { width: 120, align: "center" });
  doc.fontSize(5.5).fillColor("#5c6775").text(`${t.completed}/25 frames`, W / 2 - 60, heroY + 30, { width: 120, align: "center" });

  const roundsY = 112;
  const gap = 3;
  const colW = (usable - gap * 4) / 5;
  const rowH = 22;
  const headH = 19;
  const letters = ["A","B","C","D","E"];

  for (let round = 1; round <= 5; round++) {
    const x = left + (round - 1) * (colW + gap);
    const frames = payload.frames.filter(fr => Number(fr.round_no) === round);
    const rh = frames.filter(fr => fr.winner_side === "HOME").length;
    const ra = frames.filter(fr => fr.winner_side === "AWAY").length;

    drawCell(doc, x, roundsY, colW, headH, `ROUND ${round}     ${rh}-${ra}`, {
      size: 7, bold: true, align: "center", fill: "#e9edf2", stroke: "#7c8794"
    });

    const yHead = roundsY + headH;
    const widths = [13, colW * 0.34, 17, 17, colW * 0.34, 13];
    const labels = ["#", "HOME", "H", "A", "AWAY", "#"];
    let cx = x;
    labels.forEach((label, idx) => {
      drawCell(doc, cx, yHead, widths[idx], 15, label, { size: 4.7, bold: true, align: "center", fill: "#f7f8fa" });
      cx += widths[idx];
    });

    frames.forEach((fr, i) => {
      const y = yHead + 15 + i * rowH;
      const vals = [
        fr.home_slot,
        fr.home_player_name,
        fr.winner_side === "HOME" ? "1" : "0",
        fr.winner_side === "AWAY" ? "1" : "0",
        fr.away_player_name,
        letters[(Number(fr.away_slot || 1) - 1)] || ""
      ];
      cx = x;
      vals.forEach((val, idx) => {
        drawCell(doc, cx, y, widths[idx], rowH, val, {
          size: idx === 1 || idx === 4 ? 5.2 : 6.2,
          bold: idx === 2 || idx === 3,
          align: idx === 1 ? "left" : idx === 4 ? "right" : "center"
        });
        cx += widths[idx];
      });
    });
  }

  const summaryY = 290;
  const matchResult = t.completed < 25 ? "IN PROGRESS" :
    (t.home > t.away ? `${f.homeTeamName} WON` : t.away > t.home ? `${f.awayTeamName} WON` : "DRAW");
  const summary = [
    ["MATCH RESULT", matchResult],
    ["PLAYER OF MATCH", names.get(Number(f.playerOfMatchId)) || "-"],
    ["BREAK & RUN", names.get(Number(f.breakRunPlayerId)) || "-"],
    ["RACK & RUN", names.get(Number(f.rackRunPlayerId)) || "-"],
    ["BONUS", String(f.bonusPoints || 0)],
    ["STATUS", String(f.status || "").replaceAll("_"," ")]
  ];
  const sw = usable / summary.length;
  summary.forEach((s, i) => {
    const x = left + i * sw;
    drawCell(doc, x, summaryY, sw, 31, s[1], { size: 6.2, bold: true, align: "center", fill: i === 0 ? "#f3e8c8" : "#f7f8fa" });
    doc.font("Helvetica-Bold").fontSize(4.3).fillColor("#6a7380").text(s[0], x + 2, summaryY + 3, { width: sw - 4, align: "center" });
  });

  const signY = 336;
  const homeCaptain = names.get(Number(f.homeCaptainId)) || "-";
  const awayCaptain = names.get(Number(f.awayCaptainId)) || "-";
  doc.font("Helvetica-Bold").fontSize(6).fillColor("#2b3440").text(`HOME CAPTAIN: ${homeCaptain}`, left, signY, { width: 300 });
  doc.moveTo(left, signY + 28).lineTo(left + 310, signY + 28).strokeColor("#444").lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(5).fillColor("#666").text("Signature", left, signY + 31);
  doc.font("Helvetica-Bold").fontSize(6).fillColor("#2b3440").text(`AWAY CAPTAIN: ${awayCaptain}`, W - 326, signY, { width: 310, align: "right" });
  doc.moveTo(W - 326, signY + 28).lineTo(W - 16, signY + 28).strokeColor("#444").lineWidth(0.5).stroke();
  doc.font("Helvetica").fontSize(5).fillColor("#666").text("Signature", W - 66, signY + 31, { width: 50, align: "right" });

  doc.font("Helvetica").fontSize(5).fillColor("#7b8490")
    .text("Generated by NCSF League Manager", left, doc.page.height - 18, { width: usable, align: "center" });

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
    where.push("(f.status IN ('SCHEDULED','POSTPONED','APPROVED') OR (f.stream_active=TRUE AND f.stream_url IS NOT NULL))");
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
  res.json(await fixturePayload(await fixtureById(fixture.id)));
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

  const field = side === "HOME" ? "home_player_id" : "away_player_id";
  const { rows: alreadyScored } = await pool.query(
    `SELECT COUNT(*)::int count FROM frames WHERE fixture_id=$1 AND round_no >= $2 AND ${field}=$3 AND winner_side IS NOT NULL`,
    [fixture.id, effectiveRound, outPlayerId]
  );
  if (alreadyScored[0].count > 0 && user.role !== ROLE.NCSF) return res.status(409).json({ error: "A substitution cannot rewrite frames that are already scored." });

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
  res.json(await fixturePayload(await fixtureById(fixture.id)));
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
  res.json(await fixturePayload(await fixtureById(fixture.id)));
});

app.patch("/api/fixtures/:id/extras", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if (fixture.status === "APPROVED" && user.role !== ROLE.NCSF) return res.status(409).json({ error: "Approved fixtures are locked." });

  await pool.query(`
    UPDATE fixtures SET
      player_of_match_id=$2,
      break_run_player_id=$3,
      rack_run_player_id=$4,
      home_captain_id=$5,
      away_captain_id=$6,
      bonus_points=$7,
      notes=$8
    WHERE id=$1
  `, [
    fixture.id,
    req.body.playerOfMatchId ? Number(req.body.playerOfMatchId) : null,
    req.body.breakRunPlayerId ? Number(req.body.breakRunPlayerId) : null,
    req.body.rackRunPlayerId ? Number(req.body.rackRunPlayerId) : null,
    req.body.homeCaptainId ? Number(req.body.homeCaptainId) : null,
    req.body.awayCaptainId ? Number(req.body.awayCaptainId) : null,
    Number(req.body.bonusPoints || 0),
    String(req.body.notes || "").trim() || null
  ]);
  await audit(user.id, fixture.id, "MATCH_EXTRAS_UPDATED", req.body);
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

  const payload = await fixturePayload(fixture);
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
  "/news": "news.html",
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
  .then(() => app.listen(port, () => console.log(`NCSF League Manager listening on port ${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
