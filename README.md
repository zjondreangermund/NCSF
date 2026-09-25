# Boiler Room Pool Lounge

A pool lounge and league site built on the NCSF live match system. It keeps the existing club, team, player, fixture, scoresheet, standings, rankings, and broadcast workflows, then adds a public challenge board and a simple audited stock list.

## Boiler Room features

- Live tables, fixtures, results, club and player directories, standings, and rankings
- Player callouts reviewed by a Room Admin before they appear on the public board
- Challenge scheduling, live score updates, and match results
- Stock items with quick **Add**, **Use**, and **Count** actions and low-stock alerts
- Separate Boiler Room posts so lounge announcements and federation notices cannot leak between sites

## Keeping existing league data

To retain the current players, clubs, teams, fixtures, and results, deploy this branch as a separate service and point `DATABASE_URL` to the existing NCSF PostgreSQL database. A separate database starts without those records.

On startup, Boiler Room creates or updates the application schema and adds its stock and challenge tables. It does not run the legacy roster and fixture import jobs. One of those jobs contains a delete-and-reload step, so it must stay out of the Boiler Room startup path when sharing the live league database.

Set a separate long random `SESSION_SECRET` for the Boiler Room service. Lounge posts use their own `boiler_room_posts` table, leaving the existing NCSF posts untouched.

## Railway deployment

1. Create a new Railway service from the `boiler-room` branch; leave the existing NCSF service on its current branch.
2. Set `DATABASE_URL` to the existing NCSF PostgreSQL connection string to reuse the current league data.
3. Set a unique `SESSION_SECRET` and deploy with `npm start`.
4. Use the existing active admin login. The initial setup form is only available when the database has no users.

Startup creates the Boiler Room post, stock, and challenge tables. No sample stock or fake venue contact details are added.

## Local development

```bash
npm install
DATABASE_URL=postgres://... SESSION_SECRET=dev-secret npm run dev
```

Open http://localhost:3000.

## Ranking rule

Team and individual leaderboards retain the existing rule: frames won is the primary ranking value, with frame difference and win percentage as secondary ordering.
