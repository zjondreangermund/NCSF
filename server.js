require("dotenv").config();
require("express-async-errors");

const path = require("path");
const {buildSchedule,applyEdits,fingerprint,buildSeasonSchedule,editSeasonSchedule} = require("./schedule");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const officialPlayerLogs = require("./data/official-player-logs-2026-06-09.json");
const officialCoastalTeamLog = require("./data/official-coastal-team-log-2026-06-09.json");
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
      closed_at TIMESTAMPTZ,
      close_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE seasons ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    ALTER TABLE seasons ADD COLUMN IF NOT EXISTS close_note TEXT;

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

    CREATE TABLE IF NOT EXISTS permanent_divisions (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE CHECK(name IN ('Central','Coastal'))
    );
    INSERT INTO permanent_divisions(name) VALUES('Central'),('Coastal') ON CONFLICT(name) DO NOTHING;
    ALTER TABLE divisions ADD COLUMN IF NOT EXISTS permanent_division_id INTEGER REFERENCES permanent_divisions(id);
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS permanent_division_id INTEGER REFERENCES permanent_divisions(id);
    CREATE TABLE IF NOT EXISTS division_teams (
      division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      PRIMARY KEY(division_id,team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_division_teams_team ON division_teams(team_id);
    CREATE INDEX IF NOT EXISTS idx_teams_permanent_division ON teams(permanent_division_id);
    CREATE TABLE IF NOT EXISTS season_schedule_drafts (
      token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan JSONB NOT NULL,roster_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '2 hours'
    );
    CREATE TABLE IF NOT EXISTS schedule_drafts (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      plan JSONB NOT NULL, roster_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '2 hours'
    );
    CREATE TABLE IF NOT EXISTS playoff_slots (
      id SERIAL PRIMARY KEY, division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      slot_key TEXT NOT NULL, stage TEXT NOT NULL, round_no INTEGER NOT NULL,
      home_source JSONB NOT NULL, away_source JSONB NOT NULL,
      fixture_date TIMESTAMPTZ NOT NULL, venue TEXT,
      fixture_id INTEGER UNIQUE REFERENCES fixtures(id) ON DELETE SET NULL,
      UNIQUE(division_id,slot_key)
    );
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS competition_label TEXT;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS race_to INTEGER CHECK (race_to BETWEEN 1 AND 25);
    -- Official tournament scores are stored without inventing player-by-player frame records.
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS official_home_frames INTEGER;
    ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS official_away_frames INTEGER;
    DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='official_scores_nonnegative') THEN
        ALTER TABLE fixtures ADD CONSTRAINT official_scores_nonnegative
          CHECK ((official_home_frames IS NULL AND official_away_frames IS NULL)
            OR (official_home_frames BETWEEN 0 AND 25 AND official_away_frames BETWEEN 0 AND 25));
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS division_team_standing_snapshots (
      division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, played INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
      frames_for INTEGER NOT NULL, frames_against INTEGER NOT NULL, frame_difference INTEGER NOT NULL,
      bonus_points INTEGER NOT NULL, total_points INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'OFFICIAL', source_date DATE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(division_id,team_id)
    );
    ALTER TABLE division_team_standing_snapshots ADD COLUMN IF NOT EXISTS source_date DATE;
    CREATE TABLE IF NOT EXISTS division_player_standing_snapshots (
      division_id INTEGER NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, player_name TEXT NOT NULL, team_name TEXT NOT NULL,
      frames_played INTEGER NOT NULL, frames_won INTEGER NOT NULL,
      win_percentage NUMERIC(5,1), matches_played_percentage NUMERIC(5,1) NOT NULL,
      source TEXT NOT NULL, source_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(division_id,position)
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
      ('Qatar World Cup 10-Ball 2026','10-BALL','World Pool Association','Qatar','2026-12-05','2026-12-14',NULL,NULL,'Player entry and federation allocation details are not published on the WPA calendar; confirm with NCSF/WPA.','COMING_SOON','Listed on the WPA calendar. Confirm entry eligibility before making travel plans.',NULL,'https://wpapool.com/calendar/'),
      ('NCSF 2026 Central Zone Top 8 Playoffs','BLACKBALL','Namibia Cue Sports Federation','King Cues','2026-10-17','2026-10-17',NULL,NULL,'Qualified Top 8 Central Zone teams','INVITATION_ONLY','Saturday, 17 October at 12:00; race to 13. Quarter-final matches: Nam Shooters vs RPC, Ofifiya vs YOPC 2, Tura Boys vs Pool Pirates, and Pocket Kings NA vs Precision 7. See the attached NCSF notice for later rounds.','', '/ncsf-central-zone-top-8-playoffs-2026.pdf')
    ) AS seed(title,discipline,organizer,location,start_date,end_date,entry_fee,prize_fund,eligibility,status,description,registration_url,official_url)
    WHERE NOT EXISTS (
      SELECT 1 FROM tournament_opportunities existing
      WHERE LOWER(existing.title)=LOWER(seed.title)
    )
    ON CONFLICT DO NOTHING;

    DELETE FROM content_posts duplicate_event
    WHERE duplicate_event.type='EVENT'
      AND LOWER(duplicate_event.title)=LOWER('Central Zone Top 8 Playoffs')
      AND EXISTS (
        SELECT 1 FROM content_posts original_event
        WHERE original_event.type='EVENT'
          AND original_event.title='Top 8 Play-offs — Central Zone'
      );

    UPDATE content_posts
    SET title='Central Zone Top 8 Playoffs',
        body=E'NCSF Central Zone Top 8 Playoffs\nSaturday, 17 October 2026 at 12:00. Race to 13. Venue: King Cues.\n\nQuarter-final matches:\nNam Shooters vs RPC\nOfifiya vs YOPC 2\nTura Boys vs Pool Pirates\nPocket Kings NA vs Precision 7\n\nA walkover advances the team that pitches if its opponents do not attend.\n\nQuarter-finals: 31 October at 10:00 in the Coast (venue TBC). Semi-finals: 31 October at 15:00 in the Coast (venues per the bracket). Final: 14 November at 15:00 in Windhoek (venue TBC). Prize-giving at the Namibia Champs of Champs on 27-28 November in Windhoek (venue TBC).\n\n[Download the official NCSF notice (PDF)](/ncsf-central-zone-top-8-playoffs-2026.pdf)',
        event_date='2026-10-17 12:00:00+02'::timestamptz,
        published=TRUE,pinned=TRUE,updated_at=NOW()
    WHERE type='EVENT'
      AND title IN ('Top 8 Play-offs — Central Zone','Central Zone Top 8 Playoffs');

    INSERT INTO content_posts(type,title,body,event_date,published,pinned)
    SELECT 'EVENT',
           'Central Zone Top 8 Playoffs',
           E'NCSF Central Zone Top 8 Playoffs\nSaturday, 17 October 2026 at 12:00. Race to 13. Venue: King Cues.\n\nQuarter-final matches:\nNam Shooters vs RPC\nOfifiya vs YOPC 2\nTura Boys vs Pool Pirates\nPocket Kings NA vs Precision 7\n\nA walkover advances the team that pitches if its opponents do not attend.\n\nQuarter-finals: 31 October at 10:00 in the Coast (venue TBC). Semi-finals: 31 October at 15:00 in the Coast (venues per the bracket). Final: 14 November at 15:00 in Windhoek (venue TBC). Prize-giving at the Namibia Champs of Champs on 27-28 November in Windhoek (venue TBC).\n\n[Download the official NCSF notice (PDF)](/ncsf-central-zone-top-8-playoffs-2026.pdf)',
           '2026-10-17 12:00:00+02'::timestamptz,
           TRUE,TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM content_posts
      WHERE type='EVENT'
        AND title IN ('Top 8 Play-offs — Central Zone','Central Zone Top 8 Playoffs')
    );
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
    ["Central Zone Top 8 Playoffs","NCSF Central Zone Top 8 Playoffs. Saturday, 17 October 2026 at 12:00, race to 13 at King Cues. Quarter-final matches: Nam Shooters vs RPC; Ofifiya vs YOPC 2; Tura Boys vs Pool Pirates; Pocket Kings NA vs Precision 7. [Download the official NCSF notice (PDF)](/ncsf-central-zone-top-8-playoffs-2026.pdf)","2026-10-17T12:00:00+02:00",true],
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


async function seedOfficialPlayerLogSnapshots() {
  const migrationKey="official-player-logs-2026-06-09-v1";
  const already=await pool.query("SELECT 1 FROM app_migrations WHERE key=$1",[migrationKey]);
  if(already.rowCount)return;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const divisionLog of officialPlayerLogs.divisions){
      const wantedName=divisionLog.division;
      const division=await client.query(`
        SELECT id FROM divisions
        WHERE LOWER(name)=LOWER($1) OR LOWER(name)=LOWER($1)||' zone'
        ORDER BY CASE WHEN LOWER(name)=LOWER($1) THEN 0 ELSE 1 END,active DESC,id
        LIMIT 1
      `,[wantedName]);
      if(!division.rowCount)throw new Error("Division not found for official player log: "+wantedName);
      const divisionId=division.rows[0].id;
      await client.query("DELETE FROM division_player_standing_snapshots WHERE division_id=$1",[divisionId]);
      for(const player of divisionLog.players){
        await client.query(`
          INSERT INTO division_player_standing_snapshots
            (division_id,position,player_name,team_name,frames_played,frames_won,
             win_percentage,matches_played_percentage,source,source_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,[
          divisionId,player.position,player.player_name,player.team_name,
          player.frames_played,player.frames_won,player.win_percentage,
          player.matches_played_percentage,
          "OFFICIAL_"+wantedName.toUpperCase()+"_PLAYER_LOG_2026-06-09",
          officialPlayerLogs.asOf
        ]);
      }
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)",[migrationKey]);
    await client.query("COMMIT");
    console.log("Imported official Central and Coastal player log snapshots dated 2026-06-09.");
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }finally{
    client.release();
  }
}


async function seedOfficialPlayerTeamAssignments() {
  const key = "official-player-team-assignments-2026-06-09-v1";
  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [key]);
  if (already.rowCount) return;
  const client = await pool.connect();
  let createdCount = 0, matchedCount = 0;
  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const editDistance = (a,b) => {
    const prev=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){let current=[i];for(let j=1;j<=b.length;j++)current[j]=Math.min(current[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=current[j];}
    return prev[b.length];
  };
  try {
    await client.query("BEGIN");
    for (const divisionLog of officialPlayerLogs.divisions) {
      const divisionResult = await client.query("SELECT id FROM divisions WHERE LOWER(name)=LOWER($1) ORDER BY active DESC,id LIMIT 1", [divisionLog.division]);
      if (!divisionResult.rowCount) throw new Error("Division not found while assigning players: " + divisionLog.division);
      const divisionId = divisionResult.rows[0].id;
      const { rows: teams } = await client.query("SELECT id,name,club_id FROM teams WHERE division_id=$1 AND active=TRUE", [divisionId]);
      const { rows: players } = await client.query("SELECT p.id,p.ncsf_number,p.first_name,p.last_name,p.team_id,p.club_id FROM players p JOIN teams t ON t.id=p.team_id WHERE t.division_id=$1", [divisionId]);
      const teamKey = value => normalize(value).replace(/pc$/, "");
      for (const official of divisionLog.players) {
        const requestedTeam = teamKey(official.team_name);
        const team = teams.find(row => teamKey(row.name)===requestedTeam);
        if (!team) throw new Error("Team not found for official player " + official.player_name + " (" + official.team_name + ").");
        const parts=String(official.player_name||"").trim().split(/\s+/);
        const firstName=parts.shift()||"Unknown";
        const lastName=parts.join(" ");
        const fullKey=normalize(firstName+" "+lastName);
        const firstKey=normalize(firstName), lastKey=normalize(lastName);
        const exact=players.filter(row=>normalize(row.first_name+" "+row.last_name)===fullKey);
        let player=exact.find(row=>Number(row.team_id)===Number(team.id))||(exact.length===1?exact[0]:null);
        if (!player) {
          const sameTeam=players.filter(row=>Number(row.team_id)===Number(team.id));
          const incomplete=sameTeam.filter(row=>!String(row.last_name||"").trim() && normalize(row.first_name)===firstKey);
          if (incomplete.length===1) player=incomplete[0];
          if (!player && !lastName) {
            const shortNameMatch=sameTeam.filter(row=>normalize(row.first_name)===firstKey);
            if (shortNameMatch.length===1) player=shortNameMatch[0];
          }
          if (!player) {
            const near=sameTeam.filter(row=>normalize(row.first_name)===firstKey && String(row.last_name||"").trim() && editDistance(normalize(row.last_name),lastKey)===1);
            if (near.length===1) player=near[0];
          }
          if (!player) {
            const incompleteNear=sameTeam.filter(row=>!String(row.last_name||"").trim() && editDistance(normalize(row.first_name),firstKey)===1);
            if (incompleteNear.length===1) player=incompleteNear[0];
          }
        }
        if (player) {
          const assignedLastName=lastName || String(player.last_name||"").trim();
          await client.query("UPDATE players SET club_id=$2,team_id=$3,first_name=$4,last_name=$5,active=TRUE WHERE id=$1", [player.id,team.club_id,team.id,firstName,assignedLastName]);
          player.club_id=team.club_id; player.team_id=team.id; player.first_name=firstName; player.last_name=assignedLastName;
          matchedCount++;
        } else {
          const ncsfNumber=await generateNcsfNumber(client);
          const inserted=await client.query("INSERT INTO players(club_id,team_id,ncsf_number,first_name,last_name,active,suspended) VALUES($1,$2,$3,$4,$5,TRUE,FALSE) RETURNING id,ncsf_number,first_name,last_name,team_id,club_id", [team.club_id,team.id,ncsfNumber,firstName,lastName]);
          players.push(inserted.rows[0]);
          createdCount++;
        }
      }
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)", [key]);
    await client.query("COMMIT");
    console.log("Assigned official Central and Coastal PDF players to teams; created " + createdCount + " and matched " + matchedCount + " existing players.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function repairOfficialPlayerTeamAssignments() {
  const key="official-player-team-assignments-repair-2026-06-09-v2";
  const already=await pool.query("SELECT 1 FROM app_migrations WHERE key=$1",[key]);
  if(already.rowCount)return;
  const client=await pool.connect();
  let corrected=0,duplicates=0,created=0;
  const normalize=value=>String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const editDistance=(a,b)=>{const prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const current=[i];for(let j=1;j<=b.length;j++)current[j]=Math.min(current[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=current[j]}return prev[b.length]};
  try{
    await client.query("BEGIN");
    for(const divisionLog of officialPlayerLogs.divisions){
      const d=await client.query("SELECT id FROM divisions WHERE LOWER(name)=LOWER($1) ORDER BY active DESC,id LIMIT 1",[divisionLog.division]);
      if(!d.rowCount)throw new Error("Division not found while repairing player teams: "+divisionLog.division);
      const divisionId=d.rows[0].id;
      const {rows:teams}=await client.query("SELECT id,name,club_id FROM teams WHERE division_id=$1 AND active=TRUE",[divisionId]);
      const {rows:players}=await client.query("SELECT p.id,p.ncsf_number,p.first_name,p.last_name,p.team_id,p.club_id,p.active FROM players p JOIN teams t ON t.id=p.team_id WHERE t.division_id=$1",[divisionId]);
      const teamKey=value=>normalize(value).replace(/pc$/,"");
      for(const official of divisionLog.players){
        const team=teams.find(row=>teamKey(row.name)===teamKey(official.team_name));
        if(!team)throw new Error("Team not found for official player "+official.player_name+" ("+official.team_name+").");
        const parts=String(official.player_name||"").trim().split(/\s+/);
        const firstName=parts.shift()||"Unknown",lastName=parts.join(" ");
        const firstKey=normalize(firstName),lastKey=normalize(lastName),fullKey=normalize(firstName+" "+lastName);
        const scored=players.map(row=>{
          const rowFirst=normalize(row.first_name),rowLast=normalize(row.last_name),sameTeam=Number(row.team_id)===Number(team.id);
          let score=Infinity;
          if(rowFirst===firstKey&&rowLast===lastKey)score=sameTeam?0:10;
          else if(sameTeam&&lastName&&rowFirst===firstKey&&rowLast&&editDistance(rowLast,lastKey)===1)score=1;
          else if(sameTeam&&lastName&&rowFirst===firstKey&&!rowLast)score=2;
          else if(sameTeam&&lastName&&rowFirst===fullKey&&!rowLast)score=4;
          else if(sameTeam&&!lastName&&rowFirst===firstKey&&rowLast)score=0.5;
          else if(sameTeam&&!lastName&&!rowLast&&editDistance(rowFirst,firstKey)<=1)score=1;
          return {row,score};
        }).filter(item=>Number.isFinite(item.score)).sort((a,b)=>a.score-b.score||Number(a.row.id)-Number(b.row.id));
        let player=scored[0]?.row||null;
        if(player){
          const assignedLast=lastName||String(player.last_name||"").trim();
          await client.query("UPDATE players SET club_id=$2,team_id=$3,first_name=$4,last_name=$5,active=TRUE WHERE id=$1",[player.id,team.club_id,team.id,firstName,assignedLast]);
          player.club_id=team.club_id;player.team_id=team.id;player.first_name=firstName;player.last_name=assignedLast;player.active=true;
          corrected++;
          for(const candidate of players){
            if(Number(candidate.id)===Number(player.id)||Number(candidate.team_id)!==Number(team.id)||String(candidate.last_name||"").trim())continue;
            const malformedFull=lastName&&normalize(candidate.first_name)===fullKey;
            const duplicateShort=!lastName&&normalize(candidate.first_name)===firstKey&&Number(candidate.id)>Number(player.id);
            if(malformedFull||duplicateShort){
              await client.query("UPDATE players SET active=FALSE WHERE id=$1",[candidate.id]);
              candidate.active=false;duplicates++;
            }
          }
        }else{
          const ncsfNumber=await generateNcsfNumber(client);
          const inserted=await client.query("INSERT INTO players(club_id,team_id,ncsf_number,first_name,last_name,active,suspended) VALUES($1,$2,$3,$4,$5,TRUE,FALSE) RETURNING id,ncsf_number,first_name,last_name,team_id,club_id,active",[team.club_id,team.id,ncsfNumber,firstName,lastName]);
          players.push(inserted.rows[0]);created++;
        }
      }
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)",[key]);
    await client.query("COMMIT");
    console.log("Reconciled official PDF player assignments: corrected "+corrected+", deactivated "+duplicates+" imported duplicates, created "+created+" missing records.");
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}
async function seedOfficialCoastalTeamStandings() {
  const key = "official-coastal-team-log-2026-06-09-provisional-v1";
  const already = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [key]);
  if (already.rowCount) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const division = await client.query("SELECT id FROM divisions WHERE LOWER(name)='coastal' ORDER BY active DESC,id LIMIT 1");
    if (!division.rowCount) throw new Error("Coastal division was not found for the official team log.");
    const divisionId = division.rows[0].id;
    await client.query("DELETE FROM division_team_standing_snapshots WHERE division_id=$1", [divisionId]);
    const { rows: existingTeams } = await client.query("SELECT id,name,club_id FROM teams WHERE division_id=$1", [divisionId]);
    const normalizeTeam = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const item of officialCoastalTeamLog.teams) {
      let team = existingTeams.find(row => normalizeTeam(row.name) === normalizeTeam(item.name));
      let clubId = team?.club_id;
      if (!clubId) {
        const club = await client.query("SELECT id FROM clubs WHERE LOWER(name)=LOWER($1) LIMIT 1", [item.club_name]);
        if (club.rowCount) clubId = club.rows[0].id;
        else {
          const createdClub = await client.query("INSERT INTO clubs(name,short_name,active) VALUES($1,$1,TRUE) RETURNING id", [item.club_name]);
          clubId = createdClub.rows[0].id;
        }
      }
      if (!team) {
        const createdTeam = await client.query("INSERT INTO teams(club_id,division_id,name,short_name,active) VALUES($1,$2,$3,$3,TRUE) RETURNING id,name,club_id", [clubId,divisionId,item.name]);
        team = createdTeam.rows[0];
        existingTeams.push(team);
      } else {
        await client.query("UPDATE teams SET name=$2,short_name=$2,active=TRUE WHERE id=$1", [team.id,item.name]);
        team.name = item.name;
      }
      await client.query(
        "INSERT INTO division_team_standing_snapshots " +
        "(division_id,team_id,position,played,wins,losses,frames_for,frames_against,frame_difference,bonus_points,total_points,source,source_date) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROVISIONAL_COASTAL_TEAM_LOG_2026-06-09',$12) " +
        "ON CONFLICT(division_id,team_id) DO UPDATE SET position=EXCLUDED.position,played=EXCLUDED.played," +
        "wins=EXCLUDED.wins,losses=EXCLUDED.losses,frames_for=EXCLUDED.frames_for,frames_against=EXCLUDED.frames_against," +
        "frame_difference=EXCLUDED.frame_difference,bonus_points=EXCLUDED.bonus_points,total_points=EXCLUDED.total_points," +
        "source=EXCLUDED.source,source_date=EXCLUDED.source_date,updated_at=NOW()"
      , [divisionId,team.id,item.position,item.played,item.wins,item.losses,item.frames_for,item.frames_against,item.frame_difference,item.bonus_points,item.total_points,officialCoastalTeamLog.asOf]);
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)", [key]);
    await client.query("COMMIT");
    console.log("Imported provisional Coastal team standings from the 2026-06-09 team log.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function seedCentralTop8AndOfficialStandings() {
  const key="central-top8-fixtures-official-log-2026-10-17-v1";
  const seen=await pool.query("SELECT 1 FROM app_migrations WHERE key=$1",[key]);
  if(seen.rowCount)return;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const d=await client.query(`SELECT id FROM divisions WHERE LOWER(name)='central' ORDER BY active DESC,id LIMIT 1`);
    if(!d.rowCount)throw new Error("Central division was not found for the Top 8 playoff setup.");
    const divisionId=d.rows[0].id;
    await client.query(`
      DELETE FROM fixtures f
      WHERE f.division_id=$1 AND f.fixture_date<NOW()
        AND f.status IN ('SCHEDULED','POSTPONED')
        AND NOT EXISTS(SELECT 1 FROM frames fr WHERE fr.fixture_id=f.id AND fr.winner_side IS NOT NULL)
    `,[divisionId]);
    const standings=[
      [1,["nam shooters","namshooters"],"Nam Shooters",28,27,1,497,203,294,14,95],
      [2,["ofifiya","ofifiya pc"],"Ofifiya",28,25,3,453,247,206,12,87],
      [3,["tura boys"],"Tura Boys",28,21,7,432,268,164,10,73],
      [4,["pocket kings na"],"Pocket Kings NA",28,19,9,401,299,102,7,64],
      [5,["precision 7"],"Precision 7",28,17,11,398,302,96,3,54],
      [6,["pool pirates"],"Pool Pirates",28,16,12,347,353,-6,2,50],
      [7,["yopc 2"],"YOPC 2",28,13,15,339,361,-22,2,41],
      [8,["rpc"],"RPC",28,13,15,346,354,-8,1,40],
      [9,["queen cues"],"Queen Cues",28,13,15,332,368,-36,1,40],
      [10,["rack royalty"],"Rack Royalty",28,12,16,331,369,-38,1,37],
      [11,["007-central","007 - central"],"007-Central",28,11,17,268,432,-164,2,35],
      [12,["cue crew"],"Cue Crew",28,9,19,334,366,-32,2,29],
      [13,["yopc 1"],"YOPC 1",28,9,19,306,394,-88,1,28],
      [14,["joga bonita"],"Joga Bonita",28,5,23,262,438,-176,1,16],
      [15,["blackball bandits"],"Blackball Bandits",28,0,28,204,496,-292,0,0]
    ];
    const ids=new Map();
    for(const row of standings){
      const [position,aliases,name,played,wins,losses,framesFor,framesAgainst,diff,bonus,points]=row;
      const q=await client.query(`SELECT t.id FROM teams t WHERE t.division_id=$1 AND LOWER(t.name)=ANY($2::text[]) LIMIT 1`,[divisionId,aliases]);
      if(!q.rowCount)throw new Error("PDF Central team not found: "+name);
      const id=q.rows[0].id; ids.set(name,id);
      await client.query("UPDATE teams SET name=$2,short_name=$2 WHERE id=$1",[id,name]);
      await client.query(`INSERT INTO division_team_standing_snapshots
        (division_id,team_id,position,played,wins,losses,frames_for,frames_against,frame_difference,bonus_points,total_points,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'2026-CENTRAL-TEAM-LOG-PDF')
        ON CONFLICT(division_id,team_id) DO UPDATE SET position=EXCLUDED.position,played=EXCLUDED.played,
        wins=EXCLUDED.wins,losses=EXCLUDED.losses,frames_for=EXCLUDED.frames_for,
        frames_against=EXCLUDED.frames_against,frame_difference=EXCLUDED.frame_difference,
        bonus_points=EXCLUDED.bonus_points,total_points=EXCLUDED.total_points,source=EXCLUDED.source,updated_at=NOW()`,
        [divisionId,id,position,played,wins,losses,framesFor,framesAgainst,diff,bonus,points]);
    }
    const matches=[
      ["Nam Shooters","RPC"],
      ["Ofifiya","YOPC 2"],
      ["Tura Boys","Pool Pirates"],
      ["Pocket Kings NA","Precision 7"]
    ];
    for(const [home,away] of matches){
      const exists=await client.query(`SELECT id FROM fixtures WHERE competition_label='Central Zone Top 8 Playoffs' AND home_team_id=$1 AND away_team_id=$2 AND fixture_date='2026-10-17 12:00:00+02'::timestamptz LIMIT 1`,[ids.get(home),ids.get(away)]);
      if(!exists.rowCount)await client.query(`INSERT INTO fixtures(division_id,round_no,fixture_date,venue,home_team_id,away_team_id,status,competition_label,race_to,notes)
        VALUES($1,1,'2026-10-17 12:00:00+02'::timestamptz,'King Cues',$2,$3,'SCHEDULED','Central Zone Top 8 Playoffs',13,'Separate Central Zone Top 8 playoff fixture; race to 13.')`,[divisionId,ids.get(home),ids.get(away)]);
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)",[key]);
    await client.query("COMMIT");
    console.log("Removed past unplayed Central fixtures; seeded official Central log and separate Top 8 playoff fixtures.");
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}

// Results supplied by NCSF for the Central Top 8 matches played 17 October 2026.
// Import team totals only: no individual player results or unplayed frames are fabricated.
// The four winners advance as Central qualifiers; the Coastal Top 4 are still pending.
async function importCentralTop8Results2026() {
  const migrationKey = "central-top8-official-results-2026-10-17-v1";
  if ((await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [migrationKey])).rowCount) return;
  const results = [
    ["Nam Shooters", "RPC", 13, 2],
    ["Ofifiya", "YOPC 2", 13, 7],
    ["Tura Boys", "Pool Pirates", 13, 9],
    ["Pocket Kings NA", "Precision 7", 13, 8]
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [home, away, homeFrames, awayFrames] of results) {
      const matched = await client.query(`
        SELECT f.id,f.status,f.official_home_frames,f.official_away_frames,
          COUNT(fr.id) FILTER (WHERE fr.winner_side='HOME')::int entered_home,
          COUNT(fr.id) FILTER (WHERE fr.winner_side='AWAY')::int entered_away
        FROM fixtures f
        JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id
        LEFT JOIN frames fr ON fr.fixture_id=f.id
        WHERE f.competition_label='Central Zone Top 8 Playoffs'
          AND f.fixture_date::date='2026-10-17'
          AND ht.name=$1 AND at.name=$2
        GROUP BY f.id
      `, [home, away]);
      if (matched.rowCount!==1) throw new Error("Expected exactly one Central Top 8 fixture: "+home+" vs "+away);
      const prior=matched.rows[0];
      await client.query(`
        UPDATE fixtures
        SET official_home_frames=$2,official_away_frames=$3,
            status='APPROVED',approved_at=COALESCE(approved_at,NOW()),
            bonus_points=0,bonus_side=NULL,race_to=13,
            notes=CONCAT_WS(E'\\n',NULLIF(notes,''),'Official team result: ' || $4 || '. Central qualifier awaiting Coastal Top 4.')
        WHERE id=$1
      `,[prior.id,homeFrames,awayFrames,home+' '+homeFrames+'-'+awayFrames+' '+away]);
      await client.query(`
        INSERT INTO audit_logs(user_id,fixture_id,action,detail)
        VALUES(NULL,$1,'OFFICIAL_CENTRAL_TOP8_RESULT_IMPORTED',$2)
      `,[prior.id,JSON.stringify({source:"NCSF supplied Central Top 8 results image",playedOn:"2026-10-17",home,away,homeFrames,awayFrames,previous:{status:prior.status,enteredHome:prior.entered_home,enteredAway:prior.entered_away,officialHome:prior.official_home_frames,officialAway:prior.official_away_frames}})]);
    }
    await client.query("INSERT INTO app_migrations(key) VALUES($1)",[migrationKey]);
    await client.query("COMMIT");
    console.log("Imported four official Central Top 8 results; Coastal Top 4 still awaited.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function enforceCentralTop8KnockoutRules() {
  const key = "central-top8-race-to-13-no-bonus-2026-10-17-v1";
  const seen = await pool.query("SELECT 1 FROM app_migrations WHERE key=$1", [key]);
  if (seen.rowCount) return;
  await pool.query(`
    UPDATE fixtures
       SET race_to=13,bonus_points=0,bonus_side=NULL
     WHERE LOWER(COALESCE(competition_label,'')) LIKE 'central zone top 8 playoffs%'
  `);
  await pool.query("INSERT INTO app_migrations(key) VALUES($1)", [key]);
  console.log("Applied Central Top 8 knockout rules: race to 13, no team bonus points.");
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
    SELECT f.*, d.name division_name, s.name season_name,s.closed_at season_closed_at,
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

function rejectClosedSeason(fixture,res){
  if(!fixture?.season_closed_at)return false;
  res.status(409).json({error:"This season is closed. Ask an NCSF administrator to reopen it before making changes."});
  return true;
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

function isCentralTop8Playoff(fixture) {
  return /central zone top 8 playoffs/i.test(String(fixture?.competition_label || ""));
}

function fixtureRaceTo(fixture) {
  if (isCentralTop8Playoff(fixture)) return 13;
  return fixture?.race_to == null ? null : Number(fixture.race_to);
}

function fixtureStageLabel(fixture) {
  if (!isCentralTop8Playoff(fixture)) return fixture?.race_to ? ({2:"Quarter-final",3:"Semi-final",4:"Final"}[Number(fixture.round_no)] || "Top 8 play-off") : null;
  return ({
    1: "Top 8 play-off",
    2: "Quarter-final",
    3: "Semi-final",
    4: "Final"
  })[Number(fixture.round_no)] || `Play-off round ${Number(fixture.round_no) || 1}`;
}

function fixtureScoreIsComplete(fixture, payload) {
  const raceTo = fixtureRaceTo(fixture);
  return raceTo
    ? Math.max(Number(payload.totals.home || 0), Number(payload.totals.away || 0)) >= raceTo
    : payload.frames.length === 25 && payload.totals.completed === 25;
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
    SELECT fr.winner_side,fr.winner_player_id,f.competition_label,f.race_to
    FROM frames fr JOIN fixtures f ON f.id=fr.fixture_id
    WHERE fr.fixture_id=$1 AND fr.winner_side IS NOT NULL
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

  const knockout = Boolean(fixtureRaceTo(rows[0]));
  let bonusSide = null;
  if (!knockout && home >= 18) bonusSide = "HOME";
  else if (!knockout && away >= 18) bonusSide = "AWAY";

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
  const official=await pool.query(`
    SELECT s.position,t.id team_id,t.name team_name,c.name club_name,s.played,s.wins,s.losses,s.source,s.source_date::text source_date,
           s.frames_for frames_won,s.frames_against frames_lost,s.frame_difference,s.bonus_points,s.total_points,s.source
    FROM division_team_standing_snapshots s JOIN teams t ON t.id=s.team_id JOIN clubs c ON c.id=t.club_id
    WHERE s.division_id=$1 AND t.active=TRUE ORDER BY s.position,s.team_id
  `,[divisionId]);
  const playoffDivision=await pool.query(`
    SELECT EXISTS(
      SELECT 1 FROM fixtures
      WHERE division_id=$1 AND LOWER(COALESCE(competition_label,'')) LIKE 'central zone top 8 playoffs%'
      UNION ALL SELECT 1 FROM playoff_slots WHERE division_id=$1
    ) has_top8_playoffs
  `,[divisionId]);
  const annotatePosition=(rows)=>rows.map((row,index)=>({
    ...row,
    top8Qualifier:Boolean(playoffDivision.rows[0]?.has_top8_playoffs && Number(row.position||index+1)<=8)
  }));
  if(official.rowCount)return annotatePosition(official.rows);
  const { rows } = await pool.query(`
    WITH match_scores AS (
      SELECT f.id, f.home_team_id, f.away_team_id,
             COUNT(*) FILTER (WHERE fr.winner_side='HOME')::int home_frames,
             COUNT(*) FILTER (WHERE fr.winner_side='AWAY')::int away_frames
      FROM fixtures f
      JOIN frames fr ON fr.fixture_id=f.id
      WHERE f.division_id=$1 AND f.status='APPROVED' AND f.competition_label IS NULL
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
    WHERE (t.division_id=$1 OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$1 AND dt.team_id=t.id)) AND t.active=TRUE
    GROUP BY t.id,c.name
    ORDER BY frames_won DESC, frame_difference DESC, wins DESC, team_name ASC
  `, [divisionId]);
  return annotatePosition(rows);
}

async function getIndividualRankings(divisionId) {
  const official = await pool.query(`
    SELECT NULL::integer player_id, player_name, NULL::text ncsf_number,
           team_name, team_name club_name,
           frames_played, frames_won,
           (frames_played-frames_won)::int frames_lost,
           win_percentage::float8 win_percentage,
           matches_played_percentage::float8 matches_played_percentage,
           source, source_date::text source_date
    FROM division_player_standing_snapshots
    WHERE division_id=$1
    ORDER BY position
  `, [divisionId]);
  if (official.rowCount) return official.rows;

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
    LEFT JOIN fixtures f ON f.id=fr.fixture_id AND f.status='APPROVED' AND f.division_id=$1 AND f.competition_label IS NULL
    WHERE (t.division_id=$1 OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$1 AND dt.team_id=t.id)) AND p.active=TRUE
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
  // Prefer the NCSF-supplied team totals for approved results without full scoresheets.
  const homeFrames = fixture.status === "APPROVED" && fixture.official_home_frames != null
    ? Number(fixture.official_home_frames) : scored.filter(f => f.winner_side === "HOME").length;
  const awayFrames = fixture.status === "APPROVED" && fixture.official_away_frames != null
    ? Number(fixture.official_away_frames) : scored.filter(f => f.winner_side === "AWAY").length;

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
  const knockout = Boolean(fixtureRaceTo(fixture));
  const bonusSide = knockout ? null : homeFrames >= 18 ? "HOME" : awayFrames >= 18 ? "AWAY" : null;
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
      competitionLabel: fixture.competition_label || null,
      raceTo: fixtureRaceTo(fixture),
      officialSummaryOnly: fixture.official_home_frames != null && fixture.official_away_frames != null,
      isKnockout: knockout,
      competitionStage: fixtureStageLabel(fixture),
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
      completed: homeFrames + awayFrames,
      home: homeFrames,
      away: awayFrames,
      remaining: Math.max(0, 25 - homeFrames - awayFrames)
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
  const pdfStage = f.competitionStage || f.competitionLabel || `${f.seasonName || ""} - ${f.divisionName || ""} - Round ${f.roundNo || ""}`;
  drawPdfTextFit(doc, `${pdfStage}${f.raceTo ? ` - Race to ${f.raceTo}` : ""}`, 56, 43, usable - 90, {
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
  const bonusText = f.isKnockout ? "No bonus (knockout)" : f.bonusTeamName ? `${f.bonusTeamName} (+1)` : "-";

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
           COALESCE(f.official_home_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,
           COALESCE(f.official_away_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames
    FROM fixtures f
    JOIN teams ht ON ht.id=f.home_team_id
    JOIN teams at ON at.id=f.away_team_id
    LEFT JOIN frames fr ON fr.fixture_id=f.id
    WHERE f.competition_label IS NULL
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
    where.push(`(t.division_id=$${args.length} OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$${args.length} AND dt.team_id=t.id))`);
  }
  const { rows } = await pool.query(`
    SELECT t.id,t.name,t.short_name,d.id division_id,c.name club_name,d.name division_name,s.name season_name,
           COUNT(p.id) FILTER (WHERE p.active=TRUE)::int player_count
    FROM teams t
    JOIN clubs c ON c.id=t.club_id
    LEFT JOIN divisions d ON d.id=${req.query.divisionId?"$1":"t.division_id"}
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
    where.push(`(t.division_id=$${args.length} OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$${args.length} AND dt.team_id=t.id))`);
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
    LEFT JOIN divisions d ON d.id=${req.query.divisionId?"$1":"t.division_id"}
    LEFT JOIN frames fr ON (fr.home_player_id=p.id OR fr.away_player_id=p.id)
    LEFT JOIN fixtures f ON f.id=fr.fixture_id AND f.status='APPROVED' ${req.query.divisionId?"AND f.division_id=$1 AND f.competition_label IS NULL":""}
    WHERE ${where.join(" AND ")}
    GROUP BY p.id,t.id,t.name,c.name,d.id,d.name
    ORDER BY p.last_name,p.first_name
  `, args);
  let visibleRows=rows;
  if(req.query.divisionId){
    const divisionId=Number(req.query.divisionId);
    const {rows:officialRows}=await pool.query(`
      SELECT s.position,s.player_name,s.team_name,s.frames_played,s.frames_won,
             s.win_percentage::float8 win_percentage,
             s.matches_played_percentage::float8 matches_played_percentage,
             s.source_date::text source_date,d.id division_id,d.name division_name
      FROM division_player_standing_snapshots s
      JOIN divisions d ON d.id=s.division_id
      WHERE s.division_id=$1
      ORDER BY s.position
    `,[divisionId]);
    if(officialRows.length){
      const normalize=value=>String(value||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
      const rosterByKey=new Map();
      for(const player of rows){
        const key=normalize(player.first_name+" "+player.last_name)+"|"+normalize(player.team_name);
        if(!rosterByKey.has(key))rosterByKey.set(key,player);
      }
      const used=new Set();
      const officialPlayers=officialRows.map(log=>{
        const key=normalize(log.player_name)+"|"+normalize(log.team_name);
        let roster=rosterByKey.get(key)||null;
        if(!roster && !String(log.player_name||"").trim().includes(" ")){
          const shortMatches=rows.filter(player=>normalize(player.first_name)===normalize(log.player_name)&&normalize(player.team_name)===normalize(log.team_name));
          if(shortMatches.length===1)roster=shortMatches[0];
        }
        if(roster)used.add(roster.id);
        return {
          id:roster?.id??null,
          ncsf_number:roster?.ncsf_number??null,
          first_name:log.player_name,
          last_name:"",
          team_id:roster?.team_id??null,
          team_name:log.team_name,
          club_name:roster?.club_name||log.team_name,
          division_id:log.division_id,
          division_name:log.division_name,
          frames_played:log.frames_played,
          frames_won:log.frames_won,
          win_percentage:log.win_percentage,
          matches_played_percentage:log.matches_played_percentage,
          source_date:log.source_date
        };
      });
      const additionalPlayers=rows.filter(player=>!used.has(player.id));
      visibleRows=[...officialPlayers,...additionalPlayers]
        .sort((a,b)=>(a.first_name+" "+a.last_name).localeCompare(b.first_name+" "+b.last_name));
    }
  }
  res.json({ players: visibleRows });
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
           f.stream_url,f.stream_title,f.stream_active,f.competition_label,f.race_to,
           d.name division_name,s.name season_name,
           ht.id home_team_id,ht.name home_team_name,
           at.id away_team_id,at.name away_team_name,
           COALESCE(f.official_home_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,
           COALESCE(f.official_away_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames
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
           f.stream_url,f.stream_title,f.stream_active,f.competition_label,f.race_to,d.name division_name,
           ht.name home_team_name,at.name away_team_name,
           COALESCE(f.official_home_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,
           COALESCE(f.official_away_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames
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
             COALESCE(f.official_home_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,
             COALESCE(f.official_away_frames,COUNT(fr.id) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames
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
      pool.query("SELECT t.*,ARRAY(SELECT dt.division_id FROM division_teams dt WHERE dt.team_id=t.id) division_ids,c.name club_name,COALESCE(pd.name,d.name) division_name FROM teams t JOIN clubs c ON c.id=t.club_id LEFT JOIN divisions d ON d.id=t.division_id LEFT JOIN permanent_divisions pd ON pd.id=t.permanent_division_id ORDER BY t.name"),
      pool.query("SELECT p.*,c.name club_name,t.name team_name FROM players p JOIN clubs c ON c.id=p.club_id LEFT JOIN teams t ON t.id=p.team_id ORDER BY p.last_name,p.first_name"),
      pool.query("SELECT u.id,u.email,u.display_name,u.role,u.club_id,u.team_id,u.active,c.name club_name,t.name team_name FROM users u LEFT JOIN clubs c ON c.id=u.club_id LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.display_name")
    ]);
    return res.json({ seasons: seasons.rows, divisions: divisions.rows, permanentDivisions:(await pool.query("SELECT * FROM permanent_divisions ORDER BY name")).rows, clubs: clubs.rows, teams: teams.rows, players: players.rows, users: users.rows });
  }

  const clubId = user.club_id;
  const [divisions, clubs, teams, players, users] = await Promise.all([
    pool.query("SELECT d.*,s.name season_name FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.active=TRUE ORDER BY d.name"),
    pool.query("SELECT * FROM clubs WHERE id=$1", [clubId]),
    pool.query("SELECT t.*,ARRAY(SELECT dt.division_id FROM division_teams dt WHERE dt.team_id=t.id) division_ids,c.name club_name,COALESCE(pd.name,d.name) division_name FROM teams t JOIN clubs c ON c.id=t.club_id LEFT JOIN divisions d ON d.id=t.division_id LEFT JOIN permanent_divisions pd ON pd.id=t.permanent_division_id WHERE t.club_id=$1 ORDER BY t.name", [clubId]),
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

app.post("/api/admin/seasons",requireRoles(ROLE.NCSF),async(req,res)=>res.status(409).json({error:'Preview and approve the whole season in Fixtures. Approval creates the season, both divisions and the playoff bracket together.'}));

app.patch('/api/admin/seasons/:id',requireRoles(ROLE.NCSF),async(req,res)=>{
  const id=Number(req.params.id),name=String(req.body.name||'').trim(),start=req.body.startDate||null,end=req.body.endDate||null;
  if(!name||[start,end].some(d=>d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))))||(start&&end&&start>end))return res.status(400).json({error:'Enter a season name and valid date range.'});
  const client=await pool.connect();try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(736128)');
    const season=(await client.query('SELECT * FROM seasons WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!season)throw Error('Season not found.');
    if(season.closed_at)throw Error('Reopen this season before editing it.');
    const outside=await client.query(`SELECT 1 FROM (SELECT f.fixture_date FROM fixtures f JOIN divisions d ON d.id=f.division_id WHERE d.season_id=$1 UNION ALL SELECT p.fixture_date FROM playoff_slots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1) dates WHERE ($2::date IS NOT NULL AND (fixture_date AT TIME ZONE 'Africa/Windhoek')::date<$2) OR ($3::date IS NOT NULL AND (fixture_date AT TIME ZONE 'Africa/Windhoek')::date>$3) LIMIT 1`,[id,start,end]);
    if(outside.rowCount)throw Error('Existing fixtures fall outside these season dates. Extend the dates or edit those fixtures first.');
    if(req.body.active)await client.query('UPDATE seasons SET active=FALSE WHERE active=TRUE AND id<>$1',[id]);
    const {rows}=await client.query('UPDATE seasons SET name=$2,start_date=$3,end_date=$4,active=$5 WHERE id=$1 RETURNING *',[id,name,start,end,Boolean(req.body.active)]);
    await client.query('COMMIT');res.json({season:rows[0]});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});
app.delete('/api/admin/seasons/:id',requireRoles(ROLE.NCSF),async(req,res)=>{
  const id=Number(req.params.id),client=await pool.connect();try{
    await client.query('BEGIN');const season=(await client.query('SELECT * FROM seasons WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!season)throw Error('Season not found.');
    if(req.body.confirmName!==season.name)throw Error('Type the season name to confirm deletion.');
    await client.query('SELECT id FROM divisions WHERE season_id=$1 FOR UPDATE',[id]);
    await client.query('SELECT f.id FROM fixtures f JOIN divisions d ON d.id=f.division_id WHERE d.season_id=$1 FOR UPDATE OF f',[id]);
    const played=await client.query(`SELECT 1 FROM fixtures f JOIN divisions d ON d.id=f.division_id WHERE d.season_id=$1 AND (f.status NOT IN ('SCHEDULED','POSTPONED') OR EXISTS(SELECT 1 FROM frames fr WHERE fr.fixture_id=f.id AND fr.winner_side IS NOT NULL) OR EXISTS(SELECT 1 FROM fixture_lineups l WHERE l.fixture_id=f.id) OR EXISTS(SELECT 1 FROM fixture_attachments a WHERE a.fixture_id=f.id)) LIMIT 1`,[id]);
    if(played.rowCount)throw Error('This season has match activity. Close it to preserve its records. Only unused seasons can be deleted.');
    const snapshots=await client.query(`SELECT 1 FROM division_team_standing_snapshots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1 UNION ALL SELECT 1 FROM division_player_standing_snapshots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1 LIMIT 1`,[id]);
    if(snapshots.rowCount)throw Error('This season has official standings. Close it to preserve those records.');

    await client.query(`INSERT INTO audit_logs(user_id,action,detail) VALUES($1,'SEASON_DELETED',$2)`,[req.user.id,JSON.stringify({seasonId:id,name:season.name})]);
    await client.query('DELETE FROM seasons WHERE id=$1',[id]);await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

app.post("/api/admin/seasons/:id/close", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  const result=await pool.query("SELECT * FROM seasons WHERE id=$1",[id]);
  if(!result.rowCount)return res.status(404).json({error:"Season not found."});
  if(result.rows[0].closed_at)return res.json({season:result.rows[0],alreadyClosed:true});
  const pending=await pool.query(`
    SELECT COUNT(*) FILTER(WHERE f.status IN ('IN_PROGRESS','SUBMITTED','CONFIRMED'))::int pending,
           COUNT(*) FILTER(WHERE f.status IN ('SCHEDULED','POSTPONED'))::int unplayed
    FROM fixtures f JOIN divisions d ON d.id=f.division_id WHERE d.season_id=$1
  `,[id]);
  const counts=pending.rows[0];
  const waiting=await pool.query('SELECT COUNT(*)::int count FROM playoff_slots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1 AND p.fixture_id IS NULL',[id]);
  counts.unplayed+=waiting.rows[0].count;
  if((counts.pending||counts.unplayed)&&!req.body.force){
    return res.status(409).json({error:`There are ${counts.pending} matches awaiting completion or review and ${counts.unplayed} unplayed fixtures. Close anyway to freeze this season?`,counts});
  }
  const note=String(req.body.note||"").trim().slice(0,500)||null;
  const {rows}=await pool.query("UPDATE seasons SET closed_at=NOW(),close_note=$2,active=FALSE WHERE id=$1 RETURNING *",[id,note]);
  await audit(req.user.id,null,"SEASON_CLOSED",{seasonId:id,counts,note});
  res.json({season:rows[0],counts});
});

app.post("/api/admin/seasons/:id/reopen", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  const {rows}=await pool.query("UPDATE seasons SET closed_at=NULL,close_note=NULL,active=TRUE WHERE id=$1 RETURNING *",[id]);
  if(!rows.length)return res.status(404).json({error:"Season not found."});
  await pool.query("UPDATE seasons SET active=FALSE WHERE id<>$1",[id]);
  await audit(req.user.id,null,"SEASON_REOPENED",{seasonId:id});
  res.json({season:rows[0]});
});

app.get("/api/admin/seasons/:id/export.csv", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  const season=(await pool.query("SELECT * FROM seasons WHERE id=$1",[id])).rows[0];
  if(!season)return res.status(404).json({error:"Season not found."});
  const {rows}=await pool.query(`
    SELECT d.name division,COALESCE(f.competition_label,'League') competition,f.round_no,
      f.fixture_date,COALESCE(f.venue,'') venue,ht.name home_team,at.name away_team,
      COALESCE(f.official_home_frames,COUNT(*) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,
      COALESCE(f.official_away_frames,COUNT(*) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames,f.status,
      COALESCE(f.race_to,25) race_to
    FROM divisions d JOIN fixtures f ON f.division_id=d.id
    JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id
    LEFT JOIN frames fr ON fr.fixture_id=f.id
    WHERE d.season_id=$1 GROUP BY d.id,f.id,ht.name,at.name
    ORDER BY d.sort_order,d.name,f.fixture_date NULLS LAST,f.round_no,f.id
  `,[id]);
  const waiting=(await pool.query(`SELECT p.*,d.name division FROM playoff_slots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1 AND p.fixture_id IS NULL ORDER BY p.fixture_date,p.id`,[id])).rows;
  rows.push(...waiting.map(p=>({division:p.division,competition:p.stage+' · '+p.slot_key,round_no:p.round_no,fixture_date:p.fixture_date,venue:p.venue,home_team:p.home_source.label,away_team:p.away_source.label,home_frames:'',away_frames:'',race_to:13,status:'AWAITING_QUALIFIERS'})));
  const csvCell=value=>`"${String(value??"").replaceAll('"','""')}"`;
  const columns=["Season","Division","Competition","Round","Date","Venue","Home Team","Away Team","Home Frames","Away Frames","Race To","Status"];
  const lines=[columns,...rows.map(r=>[season.name,r.division,r.competition,r.round_no,r.fixture_date?new Date(r.fixture_date).toISOString():"",r.venue,r.home_team,r.away_team,r.home_frames,r.away_frames,r.race_to,r.status])];
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="${season.name.replace(/[^a-z0-9_-]+/gi,"-")}-fixtures.csv"`);
  res.send("\uFEFF"+lines.map(row=>row.map(csvCell).join(",")).join("\r\n"));
});

app.get("/api/admin/seasons/:id/export-standings.csv", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id),season=(await pool.query("SELECT * FROM seasons WHERE id=$1",[id])).rows[0];
  if(!season)return res.status(404).json({error:"Season not found."});
  const divisions=(await pool.query("SELECT * FROM divisions WHERE season_id=$1 ORDER BY sort_order,name",[id])).rows;
  const rows=[];
  for(const d of divisions)for(const [index,r] of (await getStandings(d.id)).entries())rows.push([season.name,d.name,r.position||index+1,r.team_name,r.played,r.wins,r.losses,r.frames_won,r.frames_lost,r.frame_difference,r.bonus_points??0,r.total_points??""]);
  const csvCell=value=>`"${String(value??"").replaceAll('"','""')}"`;
  res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="${season.name.replace(/[^a-z0-9_-]+/gi,"-")}-standings.csv"`);
  res.send("\uFEFF"+[["Season","Division","Position","Team","Played","Won","Lost","Frames For","Frames Against","Difference","Bonus Points","Points"],...rows].map(row=>row.map(csvCell).join(",")).join("\r\n"));
});

app.get("/api/admin/seasons/:id/export-players.csv", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id),season=(await pool.query("SELECT * FROM seasons WHERE id=$1",[id])).rows[0];
  if(!season)return res.status(404).json({error:"Season not found."});
  const divisions=(await pool.query("SELECT * FROM divisions WHERE season_id=$1 ORDER BY sort_order,name",[id])).rows;
  const rows=[];
  for(const d of divisions)for(const [index,r] of (await getIndividualRankings(d.id)).entries())rows.push([season.name,d.name,r.position||index+1,r.player_name,r.ncsf_number||"",r.team_name,r.frames_played,r.frames_won,r.frames_lost,Number(r.win_percentage||0).toFixed(1),Number(r.matches_played_percentage||0).toFixed(1)]);
  const csvCell=value=>`"${String(value??"").replaceAll('"','""')}"`;
  res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="${season.name.replace(/[^a-z0-9_-]+/gi,"-")}-players.csv"`);
  res.send("\uFEFF"+[["Season","Division","Position","Player","NCSF Number","Team","Frames Played","Frames Won","Frames Lost","Win %","Matches Played %"],...rows].map(row=>row.map(csvCell).join(",")).join("\r\n"));
});

app.get("/api/admin/seasons/:id/print.pdf", requireRoles(ROLE.NCSF), async (req,res) => {
  const id=Number(req.params.id);
  const season=(await pool.query("SELECT * FROM seasons WHERE id=$1",[id])).rows[0];
  if(!season)return res.status(404).json({error:"Season not found."});
  const divisions=(await pool.query("SELECT * FROM divisions WHERE season_id=$1 ORDER BY sort_order,name",[id])).rows;
  const doc=new PDFDocument({size:"A4",layout:"landscape",margin:30,bufferPages:true});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`inline; filename="${season.name.replace(/[^a-z0-9_-]+/gi,"-")}-season-report.pdf"`);
  doc.pipe(res);
  const navy="#0d2945",gold="#c6a45a",pale="#eef3f8",ink="#10243a",muted="#5d6b7b";
  const pageW=doc.page.width-60;
  const header=title=>{
    doc.rect(0,0,doc.page.width,72).fill(navy);
    doc.rect(0,70,doc.page.width,2).fill(gold);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(17).text("NAMIBIA CUE SPORTS FEDERATION",30,18,{width:pageW,align:"center"});
    doc.fillColor("#f0d28b").font("Helvetica-Bold").fontSize(10).text(title.toUpperCase(),30,43,{width:pageW,align:"center"});
    doc.y=88;
  };
  const table=(heading,headers,rows,widths)=>{
    if(doc.y>doc.page.height-92){doc.addPage();header(heading)}
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(11).text(heading,30,doc.y,{width:pageW});doc.moveDown(.45);
    const x0=30,rowH=22; let y=doc.y;
    const draw=(items,fill,bold=false)=>{
      if(!bold&&y>doc.page.height-55){doc.addPage();header(heading);y=doc.y;draw(headers,navy,true)}
      doc.rect(x0,y,pageW,rowH).fill(fill);let x=x0;
      items.forEach((item,i)=>{doc.fillColor(bold?"#ffffff":ink).font(bold?"Helvetica-Bold":"Helvetica").fontSize(bold?7:7.5).text(String(item??""),x+5,y+7,{width:widths[i]-10,height:10,ellipsis:true});x+=widths[i]});
      y+=rowH;
    };
    draw(headers,navy,true);
    rows.forEach((row,i)=>draw(row,i%2?pale:"#ffffff"));
    doc.y=y+14;
  };
  for(const [divisionIndex,division] of divisions.entries()){
    if(divisionIndex)doc.addPage();
    header(season.name+" · "+division.name+" · Official Season Report");
    const teams=await getStandings(division.id);
    table("Team standings",["POS","TEAM","P","W","L","FRAMES +","FRAMES -","DIFF","BONUS","PTS"],teams.map((r,i)=>[r.position||i+1,r.team_name,r.played,r.wins,r.losses,r.frames_won,r.frames_lost,r.frame_difference,r.bonus_points??0,r.total_points??""]),[36,260,40,40,40,75,75,64,58,55]);
    const players=await getIndividualRankings(division.id);
    table("Player standings",["POS","PLAYER","TEAM","PLAYED","WON","WIN %"],players.map((r,i)=>[r.position||i+1,r.player_name,r.team_name,r.frames_played,r.frames_won,`${Number(r.win_percentage||0).toFixed(1)}%`]),[36,235,245,85,85,62]);
    const fx=(await pool.query(`SELECT f.*,ht.name home_name,at.name away_name,
      COALESCE(f.official_home_frames,COUNT(*) FILTER(WHERE fr.winner_side='HOME'))::int home_frames,COALESCE(f.official_away_frames,COUNT(*) FILTER(WHERE fr.winner_side='AWAY'))::int away_frames
      FROM fixtures f JOIN teams ht ON ht.id=f.home_team_id JOIN teams at ON at.id=f.away_team_id
      LEFT JOIN frames fr ON fr.fixture_id=f.id WHERE f.division_id=$1
      GROUP BY f.id,ht.name,at.name ORDER BY f.fixture_date NULLS LAST,f.round_no,f.id`,[division.id])).rows;
    table("Fixtures and results",["DATE","ROUND","HOME","SCORE","AWAY","STATUS","COMPETITION"],fx.map(f=>[f.fixture_date?new Date(f.fixture_date).toLocaleDateString("en-NA",{timeZone:"Africa/Windhoek"}):"TBA",f.round_no,f.home_name,`${f.home_frames} – ${f.away_frames}`,f.away_name,f.status,(f.competition_label||"League").slice(0,28)]),[70,40,170,60,170,75,150]);
    const planned=(await pool.query('SELECT * FROM playoff_slots WHERE division_id=$1 AND fixture_id IS NULL ORDER BY round_no,id',[division.id])).rows;
    if(planned.length)table("Planned playoffs · race to 13",["STAGE","HOME / QUALIFIER","AWAY / QUALIFIER","NAMIBIA DATE / TIME","VENUE"],planned.map(p=>[p.stage+' '+p.slot_key,p.home_source.label,p.away_source.label,new Date(p.fixture_date).toLocaleString('en-GB',{timeZone:'Africa/Windhoek',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),p.venue||'TBA']),[120,190,190,150,98]);
  }
  const pages=doc.bufferedPageRange();
  for(let page=pages.start;page<pages.start+pages.count;page++){
    doc.switchToPage(page);
    doc.font("Helvetica").fontSize(7).fillColor(muted).text(`Exported ${new Date().toLocaleDateString("en-NA",{timeZone:"Africa/Windhoek"})} • ${season.closed_at?"Season closed":"Season open"} • Official NCSF League Manager record`,30,doc.page.height-45,{width:pageW,align:"center",lineBreak:false});
  }
  doc.end();
});

app.post("/api/admin/divisions",requireRoles(ROLE.NCSF),async(req,res)=>res.status(409).json({error:'Central and Coastal are permanent divisions. They are included automatically when a season schedule is approved.'}));

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
  const permanentId=Number(req.body.permanentDivisionId||0);
  const category=(await pool.query('SELECT id FROM permanent_divisions WHERE id=$1',[permanentId])).rows[0];
  if(!category)return res.status(400).json({error:'Choose Central or Coastal.'});
  const {rows}=await pool.query('INSERT INTO teams(club_id,permanent_division_id,name,short_name) VALUES($1,$2,$3,$4) RETURNING *',[clubId,permanentId,name,String(req.body.shortName||'').trim()||null]);
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
  const seasonState=await pool.query("SELECT s.closed_at FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.id=$1",[divisionId]);
  if(!seasonState.rowCount)return res.status(404).json({error:"Division not found."});
  if(seasonState.rows[0].closed_at)return res.status(409).json({error:"Reopen this season before adding fixtures."});
  const valid = await pool.query(
    "SELECT COUNT(*)::int count FROM teams t WHERE id IN ($1,$2) AND (division_id=$3 OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$3 AND dt.team_id=t.id))",
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
  if(rejectClosedSeason(fixture,res))return;

  const roundNo = req.body.roundNo === undefined ? fixture.round_no : Number(req.body.roundNo);
  const fixtureDate = req.body.fixtureDate === undefined ? fixture.fixture_date : (req.body.fixtureDate || null);
  const venue = req.body.venue === undefined ? fixture.venue : (String(req.body.venue || "").trim() || null);
  const streamUrl = req.body.streamUrl === undefined ? fixture.stream_url : (String(req.body.streamUrl || "").trim() || null);
  const streamTitle = req.body.streamTitle === undefined ? fixture.stream_title : (String(req.body.streamTitle || "").trim() || null);
  const streamActive = req.body.streamActive === undefined ? Boolean(fixture.stream_active) : Boolean(req.body.streamActive);
  if (!Number.isInteger(roundNo) || roundNo < 1) return res.status(400).json({ error: "Round number must be 1 or higher." });
  if (streamActive && !streamUrl) return res.status(400).json({ error: "A stream URL is required before going live." });

  const slot=(await pool.query('SELECT * FROM playoff_slots WHERE fixture_id=$1',[fixtureId])).rows[0];
  if(slot&&roundNo!==slot.round_no)return res.status(400).json({error:'The playoff round is fixed by the bracket. Edit its date or venue.'});
  try{await validateFixtureDate(pool,fixture.division_id,fixtureDate,slot,fixtureId)}catch(e){return res.status(400).json({error:e.message})}
  const { rows } = await pool.query(`
    UPDATE fixtures
    SET round_no=$2, fixture_date=$3, venue=$4,
        stream_url=$5,stream_title=$6,stream_active=$7
    WHERE id=$1
    RETURNING *
  `, [fixtureId, roundNo, fixtureDate, venue, streamUrl, streamTitle, streamActive]);
  if(slot)await pool.query('UPDATE playoff_slots SET fixture_date=$2,venue=$3 WHERE id=$1',[slot.id,fixtureDate,venue]);
  await audit(req.user.id, fixtureId, "FIXTURE_UPDATED", { roundNo, fixtureDate, venue, streamUrl, streamTitle, streamActive });
  res.json({ fixture: rows[0] });
});

app.post("/api/admin/fixtures/:id/postpone", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if(rejectClosedSeason(fixture,res))return;
  if (fixture.status === "APPROVED") return res.status(409).json({ error: "Approved fixtures cannot be postponed." });
  await pool.query("UPDATE fixtures SET status='POSTPONED' WHERE id=$1", [fixtureId]);
  await audit(req.user.id, fixtureId, "FIXTURE_POSTPONED", {});
  res.json(await fixturePayload(await fixtureById(fixtureId)));
});

app.post("/api/admin/fixtures/:id/restore", requireRoles(ROLE.NCSF), async (req, res) => {
  const fixtureId = Number(req.params.id);
  const fixture = await fixtureById(fixtureId);
  if (!fixture) return res.status(404).json({ error: "Fixture not found." });
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;
  const linked=await pool.query('SELECT id FROM playoff_slots WHERE fixture_id=$1',[fixtureId]);
  if(linked.rowCount)return res.status(409).json({error:'This match is linked to the playoff bracket. Edit or postpone it instead.'});
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

async function ensurePermanentDivisions(){
  await pool.query(`
    UPDATE divisions d SET permanent_division_id=p.id FROM permanent_divisions p
      WHERE d.permanent_division_id IS NULL AND d.name ~* ('(^|[^a-z])'||p.name||'([^a-z]|$)');
    UPDATE divisions d SET name=p.name FROM permanent_divisions p
      WHERE d.permanent_division_id=p.id AND d.name<>p.name
        AND NOT EXISTS(SELECT 1 FROM divisions other WHERE other.season_id=d.season_id AND other.name=p.name AND other.id<>d.id);
    UPDATE teams t SET permanent_division_id=d.permanent_division_id FROM divisions d
      WHERE t.division_id=d.id AND t.permanent_division_id IS NULL;
    INSERT INTO division_teams(division_id,team_id) SELECT division_id,id FROM teams WHERE division_id IS NOT NULL ON CONFLICT DO NOTHING;
  `);
}
async function permanentRosters(db){
  const categories=(await db.query('SELECT * FROM permanent_divisions ORDER BY name')).rows;
  const result=[];
  for(const category of categories)result.push({...category,teams:(await db.query('SELECT id,name FROM teams WHERE permanent_division_id=$1 AND active=TRUE ORDER BY id',[category.id])).rows});
  return result;
}
async function seasonHasRecords(db,id){
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM fixtures f JOIN divisions d ON d.id=f.division_id WHERE d.season_id=$1) OR EXISTS(SELECT 1 FROM playoff_slots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1) OR EXISTS(SELECT 1 FROM division_team_standing_snapshots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1) OR EXISTS(SELECT 1 FROM division_player_standing_snapshots p JOIN divisions d ON d.id=p.division_id WHERE d.season_id=$1) busy`,[id])).rows[0].busy;
}
app.post('/api/admin/season-planner',requireRoles(ROLE.NCSF),async(req,res)=>{
  const client=await pool.connect();try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(736128)');
    // Lock stable division rosters while validating and approving the draft.
    await client.query('SELECT id FROM permanent_divisions ORDER BY id FOR UPDATE');
    await client.query('SELECT id FROM teams WHERE permanent_division_id IS NOT NULL ORDER BY id FOR UPDATE');
    const rosters=await permanentRosters(client),central=rosters.find(r=>r.name==='Central'),coastal=rosters.find(r=>r.name==='Coastal');
    if(req.body.preview){
      const plan=buildSeasonSchedule(req.body,central,coastal,central.teams,coastal.teams);
      const duplicate=await client.query('SELECT id,closed_at FROM seasons WHERE LOWER(TRIM(name))=LOWER($1)',[plan.name]);
      if(duplicate.rowCount>1)throw Error('Several seasons have this name. Rename the duplicates before planning.');
      if(duplicate.rowCount){if(duplicate.rows[0].closed_at)throw Error('This season is closed. Choose a new season name.');if(await seasonHasRecords(client,duplicate.rows[0].id))throw Error('This season already has fixtures or standings. Choose a new season name.');plan.reuseSeasonId=duplicate.rows[0].id;}
      const token=crypto.randomBytes(24).toString('hex');await client.query('DELETE FROM season_schedule_drafts WHERE expires_at<NOW()');
      await client.query('INSERT INTO season_schedule_drafts(token,user_id,plan,roster_hash) VALUES($1,$2,$3,$4)',[token,req.user.id,JSON.stringify(plan),fingerprint(rosters)]);
      await client.query('COMMIT');return res.json({preview:true,token,plan});
    }
    if(req.body.approve!==true||!req.body.token)throw Error('Preview the whole season first, then approve it.');
    const draft=(await client.query('SELECT * FROM season_schedule_drafts WHERE token=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE',[req.body.token,req.user.id])).rows[0];
    if(!draft)throw Error('This season preview expired or was already approved. Preview again.');
    if(draft.roster_hash!==fingerprint(rosters))throw Error('The Central or Coastal team list changed. Preview the season again.');
    const plan=editSeasonSchedule(draft.plan,req.body.edits);
    const duplicate=await client.query('SELECT id,closed_at FROM seasons WHERE LOWER(TRIM(name))=LOWER($1)',[plan.name]);
    if(duplicate.rowCount&&(duplicate.rowCount!==1||duplicate.rows[0].id!==plan.reuseSeasonId||duplicate.rows[0].closed_at||await seasonHasRecords(client,duplicate.rows[0].id)))throw Error('This season now contains records or a duplicate was created. Preview again.');
    if(plan.reuseSeasonId&&!duplicate.rowCount)throw Error('The unused season was renamed or removed. Preview again.');
    if(plan.makeActive)await client.query('UPDATE seasons SET active=FALSE WHERE active=TRUE');
    const season=plan.reuseSeasonId?(await client.query('UPDATE seasons SET start_date=$2,end_date=$3,active=$4 WHERE id=$1 RETURNING *',[plan.reuseSeasonId,plan.startDate,plan.endDate,plan.makeActive])).rows[0]:(await client.query('INSERT INTO seasons(name,start_date,end_date,active) VALUES($1,$2,$3,$4) RETURNING *',[plan.name,plan.startDate,plan.endDate,plan.makeActive])).rows[0];
    const ids=new Map();
    for(const d of plan.divisions){
      let created=(await client.query('SELECT id FROM divisions WHERE season_id=$1 AND name=$2',[season.id,d.divisionName])).rows[0];
      if(!created)created=(await client.query('INSERT INTO divisions(season_id,name,permanent_division_id) VALUES($1,$2,$3) RETURNING id',[season.id,d.divisionName,d.divisionId])).rows[0];
      else await client.query('UPDATE divisions SET permanent_division_id=$2 WHERE id=$1',[created.id,d.divisionId]);
      ids.set(d.divisionId,created.id);
      for(const t of d.teams)await client.query('INSERT INTO division_teams(division_id,team_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[created.id,t.id]);
      for(const f of d.fixtures)await client.query('INSERT INTO fixtures(division_id,round_no,fixture_date,venue,home_team_id,away_team_id) VALUES($1,$2,$3,$4,$5,$6)',[created.id,f.roundNo,f.fixtureDate,f.venue||null,f.homeTeamId,f.awayTeamId]);
    }
    let playoffs=0;
    for(const d of plan.divisions)for(const f of d.playoffs){
      const mapSource=source=>source.rank?{...source,divisionId:ids.get(source.divisionId)}:source;
      await client.query('INSERT INTO playoff_slots(division_id,slot_key,stage,round_no,home_source,away_source,fixture_date,venue) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ids.get(d.divisionId),f.key,f.stage,f.roundNo,JSON.stringify(mapSource(f.home)),JSON.stringify(mapSource(f.away)),f.fixtureDate,f.venue||null]);playoffs++;
    }
    await client.query('DELETE FROM season_schedule_drafts WHERE token=$1',[req.body.token]);
    await client.query(`INSERT INTO audit_logs(user_id,action,detail) VALUES($1,'WHOLE_SEASON_APPROVED',$2)`,[req.user.id,JSON.stringify({seasonId:season.id,divisions:[...ids.values()]})]);
    await client.query('COMMIT');res.status(201).json({season,created:plan.divisions.reduce((n,d)=>n+d.fixtures.length,0),playoffs,divisions:[...ids.values()]});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

async function validateFixtureDate(db,divisionId,value,slot=null,fixtureId=null){
  if(!value){if(slot)throw Error('Playoff fixtures need a date and time.');return}
  const date=new Date(value);if(!Number.isFinite(date.getTime()))throw Error('Enter a valid fixture date.');
  const local=new Date(date.getTime()+7200000).toISOString().slice(0,10);
  const season=(await db.query('SELECT s.start_date,s.end_date FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.id=$1',[divisionId])).rows[0];
  if((season?.start_date&&local<dateOnly(season.start_date))||(season?.end_date&&local>dateOnly(season.end_date)))throw Error('The fixture must fall within the season dates.');
  if(fixtureId){
    const clash=await db.query(`SELECT 1 FROM fixtures f JOIN fixtures current ON current.id=$1 WHERE f.id<>current.id AND (f.home_team_id IN (current.home_team_id,current.away_team_id) OR f.away_team_id IN (current.home_team_id,current.away_team_id)) AND ABS(EXTRACT(EPOCH FROM (f.fixture_date-$2::timestamptz)))<16200 LIMIT 1`,[fixtureId,value]);
    if(clash.rowCount)throw Error('Allow at least 4½ hours between games for the same team.');
    const day=await db.query(`SELECT team_id FROM fixtures current CROSS JOIN LATERAL (VALUES(current.home_team_id),(current.away_team_id)) AS sides(team_id) JOIN fixtures f ON f.id<>current.id AND sides.team_id IN(f.home_team_id,f.away_team_id) WHERE current.id=$1 AND (f.fixture_date AT TIME ZONE 'Africa/Windhoek')::date=($2::timestamptz AT TIME ZONE 'Africa/Windhoek')::date GROUP BY sides.team_id HAVING COUNT(*)>=2`,[fixtureId,value]);
    if(day.rowCount)throw Error('A team cannot play more than two games on the same day.');
  }
  if(!slot&&fixtureId){
    const fixture=(await db.query('SELECT competition_label FROM fixtures WHERE id=$1',[fixtureId])).rows[0];
    if(!fixture?.competition_label){const slots=await db.query(`SELECT fixture_date FROM playoff_slots WHERE home_source @> $1::jsonb OR away_source @> $1::jsonb`,[JSON.stringify({divisionId})]);if(slots.rows.some(s=>date>=new Date(s.fixture_date)))throw Error('League fixtures must finish before the qualifying playoff stage.');}
  }
  if(slot){
    const all=(await db.query('SELECT * FROM playoff_slots WHERE division_id=$1',[divisionId])).rows;
    for(const row of all){
      if([slot.home_source,slot.away_source].some(s=>s.winner===row.slot_key)&&date-new Date(row.fixture_date)<4.5*3600000)throw Error('This round must start at least 4½ hours after its feeder matches.');
      if([row.home_source,row.away_source].some(s=>s.winner===slot.slot_key)&&new Date(row.fixture_date)-date<4.5*3600000)throw Error('This match must finish before the next round starts; allow 4½ hours between starts.');
    }
    for(const source of [slot.home_source,slot.away_source].filter(s=>s.rank)){
      const last=(await db.query('SELECT MAX(fixture_date) last FROM fixtures WHERE division_id=$1 AND competition_label IS NULL',[source.divisionId])).rows[0]?.last;
      if(last&&date<=new Date(last))throw Error('Qualification matches must take place after their league fixtures.');
    }
  }
}
function dateOnly(value){return value ? (typeof value.toISOString==='function'?value.toISOString():String(value)).slice(0,10):null}
async function scheduleRoster(db,divisionId){return (await db.query("SELECT t.id,t.name FROM teams t WHERE (t.division_id=$1 OR EXISTS(SELECT 1 FROM division_teams dt WHERE dt.division_id=$1 AND dt.team_id=t.id)) AND t.active=TRUE ORDER BY t.id",[divisionId])).rows}
app.post("/api/admin/divisions/:id/generate-home-away", requireRoles(ROLE.NCSF), async (req,res)=>{
  const id=Number(req.params.id),client=await pool.connect();
  try{
    await client.query('BEGIN');
    const division=(await client.query(`SELECT d.*,s.start_date,s.end_date,s.closed_at FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.id=$1 FOR UPDATE OF d,s`,[id])).rows[0];
    if(!division)throw Error('Division not found.');
    if(division.closed_at)throw Error('Reopen this season before generating fixtures.');
    const teams=await scheduleRoster(client,id);
    const existing=await client.query('SELECT id FROM fixtures WHERE division_id=$1 LIMIT 1',[id]);
    const existingSlots=await client.query('SELECT id FROM playoff_slots WHERE division_id=$1 LIMIT 1',[id]);
    if(existing.rowCount||existingSlots.rowCount)throw Error('This division already has a schedule. Edit its existing fixtures, or choose a new season/division.');
    if(req.body.preview){
      let opponent=null;
      if(req.body.format==='central-coastal'){
        opponent=(await client.query('SELECT id,name FROM divisions WHERE id=$1 AND season_id=$2 AND id<>$3',[Number(req.body.opponentDivisionId),division.season_id,id])).rows[0];
        if(!opponent||(await scheduleRoster(client,opponent.id)).length<4)throw Error('The opposing division must belong to this season and have at least four active teams.');
      }
      const plan=buildSchedule(teams,division,String(req.body.firstDate||''),req.body.format||'top8',opponent);
      if(opponent)plan.opponentRoster=await scheduleRoster(client,opponent.id);
      const token=crypto.randomBytes(24).toString('hex');
      await client.query('DELETE FROM schedule_drafts WHERE expires_at<NOW()');
      await client.query('INSERT INTO schedule_drafts(token,user_id,division_id,plan,roster_hash) VALUES($1,$2,$3,$4,$5)',[token,req.user.id,id,JSON.stringify(plan),fingerprint(teams)]);
      await client.query('COMMIT');
      return res.json({preview:true,token,plan,startDate:dateOnly(division.start_date),endDate:dateOnly(division.end_date)});
    }
    if(req.body.approve!==true||!req.body.token)throw Error('Preview the fixtures first, then approve the schedule.');
    const draft=(await client.query('SELECT * FROM schedule_drafts WHERE token=$1 AND user_id=$2 AND division_id=$3 AND expires_at>NOW() FOR UPDATE',[req.body.token,req.user.id,id])).rows[0];
    if(!draft)throw Error('This preview expired or was already approved. Preview again.');
    if(draft.roster_hash!==fingerprint(teams))throw Error('The team list changed. Preview again before approval.');
    if(draft.plan.opponentRoster&&fingerprint(draft.plan.opponentRoster)!==fingerprint(await scheduleRoster(client,draft.plan.opponentDivisionId)))throw Error('The opposing team list changed. Preview again.');
    const plan=applyEdits(draft.plan,req.body.edits,dateOnly(division.start_date),dateOnly(division.end_date));
    if(plan.opponentDivisionId){const last=(await client.query('SELECT MAX(fixture_date) last FROM fixtures WHERE division_id=$1 AND competition_label IS NULL',[plan.opponentDivisionId])).rows[0]?.last;if(last&&plan.playoffs.filter(f=>f.stage==='Quarter-final').some(f=>new Date(f.fixtureDate)<=new Date(last)))throw Error('The opposing league ends after the quarter-finals. Edit the quarter-final dates before approval.');}
    for(const f of plan.fixtures)await client.query(`INSERT INTO fixtures(division_id,round_no,fixture_date,venue,home_team_id,away_team_id) VALUES($1,$2,$3,$4,$5,$6)`,[id,f.roundNo,f.fixtureDate,f.venue||null,f.homeTeamId,f.awayTeamId]);
    for(const f of plan.playoffs)await client.query(`INSERT INTO playoff_slots(division_id,slot_key,stage,round_no,home_source,away_source,fixture_date,venue) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,f.key,f.stage,f.roundNo,JSON.stringify(f.home),JSON.stringify(f.away),f.fixtureDate,f.venue||null]);
    await client.query('DELETE FROM schedule_drafts WHERE division_id=$1',[id]);
    await client.query(`INSERT INTO audit_logs(user_id,action,detail) VALUES($1,'SCHEDULE_APPROVED',$2)`,[req.user.id,JSON.stringify({divisionId:id,fixtures:plan.fixtures.length,playoffs:plan.playoffs.length})]);
    await client.query('COMMIT');res.status(201).json({created:plan.fixtures.length,playoffs:plan.playoffs.length});
  }catch(error){await client.query('ROLLBACK');res.status(400).json({error:error.message})}finally{client.release()}
});

async function advancePlayoffs(divisionId){
  const client=await pool.connect();let created=0;
  try{
    await client.query('BEGIN');
    const division=(await client.query(`SELECT d.*,s.closed_at FROM divisions d JOIN seasons s ON s.id=d.season_id WHERE d.id=$1 FOR UPDATE OF d,s`,[divisionId])).rows[0];
    if(!division||division.closed_at)throw Error('The season is closed or missing.');
    const slots=(await client.query('SELECT * FROM playoff_slots WHERE division_id=$1 ORDER BY round_no,id FOR UPDATE',[divisionId])).rows;
    const resolve=async source=>{
      if(source.rank){
        const status=(await client.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status<>'APPROVED')::int pending FROM fixtures WHERE division_id=$1 AND competition_label IS NULL`,[source.divisionId])).rows[0];
        if(!status.total||status.pending)return null;
        const table=await getStandings(source.divisionId);
        return table[source.rank-1]?.team_id||null;
      }
      const prev=slots.find(s=>s.slot_key===source.winner);
      if(!prev?.fixture_id)return null;
      const result=(await client.query(`SELECT f.home_team_id,f.away_team_id,f.status,COALESCE(f.official_home_frames,COUNT(*) FILTER(WHERE fr.winner_side='HOME'))::int home,COALESCE(f.official_away_frames,COUNT(*) FILTER(WHERE fr.winner_side='AWAY'))::int away FROM fixtures f LEFT JOIN frames fr ON fr.fixture_id=f.id WHERE f.id=$1 GROUP BY f.id`,[prev.fixture_id])).rows[0];
      if(result?.status!=='APPROVED'||Math.max(result.home,result.away)<13||result.home===result.away)return null;
      return result.home>result.away?result.home_team_id:result.away_team_id;
    };
    for(const slot of slots){
      if(slot.fixture_id)continue;
      const home=await resolve(slot.home_source),away=await resolve(slot.away_source);if(!home||!away)continue;
      const f=await client.query(`INSERT INTO fixtures(division_id,round_no,fixture_date,venue,home_team_id,away_team_id,competition_label,race_to,notes) VALUES($1,$2,$3,$4,$5,$6,$7,13,$8) RETURNING id`,[divisionId,slot.round_no,slot.fixture_date,slot.venue,home,away,division.name+' Season Playoffs',slot.stage+' · '+slot.slot_key]);
      slot.fixture_id=f.rows[0].id;
      await client.query('UPDATE playoff_slots SET fixture_id=$2 WHERE id=$1',[slot.id,slot.fixture_id]);created++;
    }
    await client.query('COMMIT');return created;
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
app.get('/api/divisions/:id/playoffs',async(req,res)=>{
  const {rows}=await pool.query(`SELECT ps.*,ht.name home_team_name,at.name away_team_name,f.status FROM playoff_slots ps LEFT JOIN fixtures f ON f.id=ps.fixture_id LEFT JOIN teams ht ON ht.id=f.home_team_id LEFT JOIN teams at ON at.id=f.away_team_id WHERE ps.division_id=$1 ORDER BY ps.round_no,ps.id`,[Number(req.params.id)]);
  res.json({slots:rows});
});
app.post('/api/admin/divisions/:id/advance-playoffs',requireRoles(ROLE.NCSF),async(req,res)=>{
  res.json({created:await advancePlayoffs(Number(req.params.id))});
});
app.patch('/api/admin/playoff-slots/:id',requireRoles(ROLE.NCSF),async(req,res)=>{
  const client=await pool.connect();try{
    await client.query('BEGIN');
    const slot=(await client.query(`SELECT ps.*,s.closed_at FROM playoff_slots ps JOIN divisions d ON d.id=ps.division_id JOIN seasons s ON s.id=d.season_id WHERE ps.id=$1 FOR UPDATE OF ps,s`,[Number(req.params.id)])).rows[0];
    if(!slot||slot.closed_at)throw Error('Reopen the season before editing its playoff fixtures.');
    if(!req.body.fixtureDate||!Number.isFinite(Date.parse(req.body.fixtureDate)))throw Error('Choose a valid date and time.');
    const venue=String(req.body.venue||'').trim().slice(0,200);
    await validateFixtureDate(client,slot.division_id,req.body.fixtureDate,slot,slot.fixture_id);
    await client.query('UPDATE playoff_slots SET fixture_date=$2,venue=$3 WHERE id=$1',[slot.id,req.body.fixtureDate,venue]);
    if(slot.fixture_id)await client.query('UPDATE fixtures SET fixture_date=$2,venue=$3 WHERE id=$1',[slot.fixture_id,req.body.fixtureDate,venue]);
    await client.query('COMMIT');res.json({ok:true});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

app.put("/api/fixtures/:id/lineup", requireAuth, async (req, res) => {
  const fixture = await fixtureById(Number(req.params.id));
  const user = await currentUserById(req.session.userId);
  if (!fixture || !canManageFixture(user, fixture)) return res.status(403).json({ error: "No access to this fixture." });
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;
  if (["SUBMITTED","CONFIRMED","APPROVED"].includes(fixture.status) && user.role !== ROLE.NCSF) return res.status(409).json({ error: "This score sheet is locked." });

  const winnerSide = req.body.winnerSide === null ? null : String(req.body.winnerSide || "").toUpperCase();
  if (winnerSide !== null && !["HOME","AWAY"].includes(winnerSide)) return res.status(400).json({ error: "Winner must be HOME or AWAY." });

  const { rows: frameRows } = await pool.query("SELECT * FROM frames WHERE id=$1 AND fixture_id=$2", [Number(req.params.frameId), fixture.id]);
  const frame = frameRows[0];
  if (!frame) return res.status(404).json({ error: "Frame not found." });
  const raceTo = fixtureRaceTo(fixture);
  if(winnerSide&&!frame.winner_side&&raceTo){
    const {rows:scores}=await pool.query(`SELECT COUNT(*) FILTER(WHERE winner_side='HOME')::int home,COUNT(*) FILTER(WHERE winner_side='AWAY')::int away FROM frames WHERE fixture_id=$1`,[fixture.id]);
    if(Math.max(Number(scores[0].home),Number(scores[0].away))>=raceTo)return res.status(409).json({error:"This race-to match is complete. Clear a scored frame to correct it before continuing."});
  }
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
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;

  const submittingSide = sideForUser(user, fixture);
  if (!["HOME","AWAY"].includes(submittingSide)) {
    return res.status(403).json({ error: "A participating team or its club admin must submit the result." });
  }
  if (!["SCHEDULED","IN_PROGRESS"].includes(fixture.status)) {
    return res.status(409).json({ error: "This result has already been submitted." });
  }

  await syncDerivedFixtureExtras(fixture.id);
  const payload = await fixturePayload(await fixtureById(fixture.id));
  const raceTo=fixtureRaceTo(fixture);
  const complete=fixtureScoreIsComplete(fixture,payload);
  if(!complete)return res.status(409).json({error:raceTo?`A team must reach ${raceTo} frames before submission.`:"All 25 frames must be completed before submission."});
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
  if(rejectClosedSeason(fixture,res))return;
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
  if(rejectClosedSeason(fixture,res))return;
  if (fixture.status !== "CONFIRMED") return res.status(409).json({ error: "The opposing team must confirm the submitted result before NCSF approval." });

  const payload = await fixturePayload(fixture);
  const raceTo=fixtureRaceTo(fixture);
  const complete=fixtureScoreIsComplete(fixture,payload);
  if(!complete)return res.status(409).json({error:raceTo?`A team must reach ${raceTo} frames before approval.`:"All 25 frames must be scored."});

  await pool.query(
    "UPDATE fixtures SET status='APPROVED',approved_by=$2,approved_at=NOW() WHERE id=$1",
    [fixture.id, req.user.id]
  );
  await audit(req.user.id, fixture.id, "MATCH_APPROVED", { totals: payload.totals });
  const plans=await pool.query(`SELECT DISTINCT ps.division_id FROM playoff_slots ps JOIN divisions d ON d.id=ps.division_id WHERE d.season_id=(SELECT season_id FROM divisions WHERE id=$1)`,[fixture.division_id]);
  for(const plan of plans.rows)try{await advancePlayoffs(plan.division_id)}catch(error){console.error('Playoff advancement pending:',error.message)}

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
  const raceTo=fixtureRaceTo(fixture);
  const matchComplete=raceTo?Math.max(payload.totals.home,payload.totals.away)>=raceTo:payload.totals.completed>=25;
  const currentIndex=matchComplete?-1:frames.findIndex(fr=>!fr.winner_side);
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
    competitionLabel: fixture.competition_label || null,
    competitionStage: fixtureStageLabel(fixture),
    raceTo,
    fixtureTotalFrames:25,
    final:matchComplete,
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
    final: matchComplete
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
  .then(seedCentralTop8AndOfficialStandings)
  .then(enforceCentralTop8KnockoutRules)
  .then(importCentralTop8Results2026)
  .then(seedOfficialCoastalTeamStandings)
  .then(seedOfficialPlayerLogSnapshots)
  .then(seedOfficialPlayerTeamAssignments)
  .then(repairOfficialPlayerTeamAssignments)
  .then(ensurePermanentDivisions)
  .then(() => httpServer.listen(port, () => console.log(`NCSF League Manager listening on port ${port}`)))
  .catch(error => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
