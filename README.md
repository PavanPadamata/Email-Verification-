# Email Verifier

Bulk email verification system using [check-if-email-exists](https://github.com/reacherhq/check-if-email-exists) CLI.

## Architecture

```
Frontend (React) → Backend API (Express) → Worker (Node child_process) → Reacher CLI → SOCKS5 Proxy (optional)
```

- **Backend**: REST API, file-based job storage at `/jobs/{jobId}/`
- **Worker**: Polls `/jobs` for pending work, runs CLI with p-limit concurrency, writes `valid.csv / invalid.csv / risky.csv`
- **Proxy pool**: Round-robin, auto-disables on 3 consecutive failures, re-enables after 5 min

## Folder Structure

```
├── backend/         Express API server
├── worker/          Email verification worker
├── frontend/        React UI (Vite)
├── docker/          Dockerfiles
├── docker-compose.yml
└── .env.example
```

## Quick Start

```bash
cp .env.example .env
# Edit .env to configure proxies, concurrency, etc.

docker-compose up --build

# Scale workers
docker-compose up --scale worker=3
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## Classification Logic

| Result | Classification |
|--------|---------------|
| SMTP deliverable=true | valid |
| SMTP deliverable=false | invalid |
| Disposable domain | invalid |
| MX records missing | invalid |
| Catch-all / unknown | risky |
| Connect failed / timeout | risky |

## Proxy Config

```
PROXIES=socks5://user:pass@host1:1080,socks5://user:pass@host2:1080
```

Each worker instance shares the proxy pool configuration. Scale with:
```bash
docker-compose up --scale worker=5
```
