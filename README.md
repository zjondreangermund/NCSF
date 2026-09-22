# NCSF League Manager

A responsive competition-management platform for the Namibia Cue Sports Federation.

## Phase 1
- 5-a-side team league with reserves
- Home-and-away fixtures
- 5 rounds / 25 frames per fixture (every starter meets every opposing starter once)
- Digital scoresheet with autosave
- Signed scoresheet image/PDF upload
- Team standings ranked by frames won
- Individual rankings ranked by frames won
- NCSF admin, club admin and team admin access
- Club admins can create/manage players and distribute team access
- Fixture submission, opponent confirmation, club/NCSF approval and audit trail
- Print/PDF-friendly match sheet
- PostgreSQL-backed persistent data and uploaded score sheets

## Railway deployment
1. Create a PostgreSQL service.
2. Deploy this repository as a Node service.
3. Set `DATABASE_URL` to the PostgreSQL connection string.
4. Set `SESSION_SECRET` to a long random value.
5. The first visit will offer a one-time "Create first NCSF admin" setup if there are no users.

The server creates the required database tables automatically on startup.

## Local development

```bash
npm install
DATABASE_URL=postgres://... SESSION_SECRET=dev-secret npm run dev
```

Open http://localhost:3000.

## Ranking rule
Both team and individual leaderboards use **frames won** as the primary ranking value. Ties are displayed with frame difference / win percentage as secondary ordering only so the primary NCSF rule remains frames won.
