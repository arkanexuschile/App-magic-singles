# Deploy en DigitalOcean VPS (Droplet)

Guia para dejar la app en produccion en un VPS Ubuntu y ejecutar el scheduler via HTTP tick.

## 1) Requisitos

- Ubuntu 22.04/24.04 en Droplet.
- Dominio apuntando al VPS (A record).
- App Shopify configurada con URL publica HTTPS.

## 2) Instalar dependencias del sistema

```bash
sudo apt update
sudo apt install -y nginx curl git ufw
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 3) Clonar y preparar proyecto

```bash
sudo mkdir -p /var/www/shopify-price
sudo chown -R $USER:$USER /var/www/shopify-price
cd /var/www/shopify-price
git clone <TU_REPO_GIT> .
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
```

## 4) Variables de entorno de produccion

Crea `/var/www/shopify-price/.env`:

```bash
NODE_ENV=production
PORT=3000

SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
SCOPES=...
SHOPIFY_APP_URL=https://tu-dominio.com

DATABASE_URL=file:./prisma/dev.sqlite

CRON_SECRET=pon-un-secret-largo-y-unico
SYNC_SCHEDULER_MODE=http
```

Nota:
- `SYNC_SCHEDULER_MODE=http` desactiva el loop en memoria.
- El cron externo/local debe llamar `POST /internal/scheduler/tick` con header `x-cron-secret`.

## 5) Servicio systemd para la app

Crear `/etc/systemd/system/shopify-price.service`:

```ini
[Unit]
Description=Shopify Price App
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/shopify-price
EnvironmentFile=/var/www/shopify-price/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Activar servicio:

```bash
sudo systemctl daemon-reload
sudo systemctl enable shopify-price
sudo systemctl start shopify-price
sudo systemctl status shopify-price
```

Logs:

```bash
sudo journalctl -u shopify-price -f
```

## 6) Nginx reverse proxy

Crear `/etc/nginx/sites-available/shopify-price`:

```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Activar sitio:

```bash
sudo ln -s /etc/nginx/sites-available/shopify-price /etc/nginx/sites-enabled/shopify-price
sudo nginx -t
sudo systemctl reload nginx
```

## 7) HTTPS (Let’s Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tu-dominio.com
```

## 8) Programar cron del scheduler (recomendado con systemd timer)

### 8.1 Script de tick

Crear `/usr/local/bin/shopify-price-tick.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

CRON_SECRET="$(grep '^CRON_SECRET=' /var/www/shopify-price/.env | cut -d '=' -f2-)"

curl -sS -X POST "http://127.0.0.1:3000/internal/scheduler/tick" \
  -H "x-cron-secret: ${CRON_SECRET}" \
  -H "Content-Type: application/json" >/dev/null
```

Permisos:

```bash
sudo chmod +x /usr/local/bin/shopify-price-tick.sh
```

### 8.2 Servicio one-shot

Crear `/etc/systemd/system/shopify-price-tick.service`:

```ini
[Unit]
Description=Run Shopify Price scheduler tick once

[Service]
Type=oneshot
ExecStart=/usr/local/bin/shopify-price-tick.sh
```

### 8.3 Timer cada minuto

Crear `/etc/systemd/system/shopify-price-tick.timer`:

```ini
[Unit]
Description=Run Shopify Price scheduler tick every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true

[Install]
WantedBy=timers.target
```

Activar timer:

```bash
sudo systemctl daemon-reload
sudo systemctl enable shopify-price-tick.timer
sudo systemctl start shopify-price-tick.timer
sudo systemctl list-timers | grep shopify-price-tick
```

Logs tick:

```bash
sudo journalctl -u shopify-price-tick.service -f
sudo journalctl -u shopify-price -f | grep price-sync-scheduler
```

## 9) Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 10) Checklist final

- `https://tu-dominio.com` responde.
- App instala y autentica en Shopify.
- `CRON_SECRET` configurado.
- Timer activo cada minuto.
- Logs muestran:
  - `[price-sync-scheduler] ... tick start`
  - `[price-sync-scheduler] ... tick due shops`
  - `runner started/completed` cuando hay ejecuciones pendientes.

