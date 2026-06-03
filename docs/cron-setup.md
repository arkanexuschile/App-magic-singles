# Cron Setup (Dev + Production)

This app uses an HTTP tick endpoint to run due sync jobs.

## Required environment variables

- `CRON_SECRET`: shared secret for the internal tick endpoint.
- `SYNC_SCHEDULER_MODE`: set to `http` (recommended) or `interval` (legacy in-process loop).

Recommended value:

```bash
SYNC_SCHEDULER_MODE=http
```

## Internal tick endpoint

- Method: `POST`
- Path: `/internal/scheduler/tick`
- Required header: `x-cron-secret: <CRON_SECRET>`

## Development

1. Run the app:

```bash
npm run dev
```

2. In another terminal, run the local cron caller:

```bash
npm run cron:dev
```

Optional env vars for dev caller:

- `APP_BASE_URL` (default: `http://localhost:3000`)
- `CRON_TICK_SECONDS` (default: `60`)

## Production

1. Deploy app with:
- `CRON_SECRET` configured
- `SYNC_SCHEDULER_MODE=http`

2. Configure any scheduler service to call every minute:
- URL: `https://<your-app-domain>/internal/scheduler/tick`
- Method: `POST`
- Header: `x-cron-secret: <CRON_SECRET>`

Examples of scheduler services:
- Cloudflare Cron Triggers + Worker
- GitHub Actions (scheduled workflow)
- Railway Cron
- Render Cron
- UptimeRobot/health check style scheduler (with POST support)

## Why this model

- Same scheduler path in dev and production.
- Not tied to process memory (`setInterval` in web process).
- Survives app restarts and redeploys.
