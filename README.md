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
- NCSF season close/reopen workflow with scored data retained and locked
- Season PDF report plus separate fixtures, team standings and player ranking CSV exports
- Double round-robin schedule generation that skips full weeks containing Namibian public holidays
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

### Preview and approve a season schedule

In Administration → Fixtures, select the season/division and first match date. Choose the current Central/Coastal format (Central Top 8 qualifiers, cross-zone quarter-finals, semi-finals and final), a single-division Top 8 bracket, or league only. The opposing division must belong to the same season.

Preview shows every league pairing and playoff slot. Edit dates/times and venues directly in the draft, then select **Approve schedule & save to season**. Preview does not publish fixtures. Approval saves exactly the reviewed draft and rejects duplicate or expired approvals, changed rosters, conflicting starts and dates outside the season. League fixtures use two starts per day, 10:30 and 15:00 Namibia time, and skip public-holiday weeks.

The saved playoff bracket retains date/venue editing and fills opponents from final league positions and approved knockout winners. Every knockout is race to 13 with no league bonus. A refresh/advance button retries qualification after results are approved. Unresolved playoff slots appear on the public fixture page and in season exports.

League Setup has season name/date/active editing and deletion for unused seasons. Seasons with match activity or official standings must be closed rather than deleted; deleting an unused season keeps its clubs, teams, players and logins. Schedule approval does not switch the active season—use the season editor when ready to make the next season active.

Run schedule checks with `npm test`.
