# Installer: Cron Worker (Ubuntu/CentOS)

Este instalador configura solo la parte de cron worker (HTTP tick) con `systemd`.

## Requisitos

- Distro soportada: `ubuntu`, `centos`, `rhel`, `rocky`, `almalinux`.
- App ya corriendo localmente en el VPS (ejemplo: puerto 3000).
- Archivo `.env` existente (por defecto: `/var/www/shopify-price/.env`).

## Variables clave en `.env`

- `CRON_SECRET` (obligatoria)
- `SYNC_SCHEDULER_MODE=http` (recomendado)
- `PORT` (opcional; fallback `3000`)

## Ejecutar instalador

```bash
sudo bash ./scripts/install-cron-worker.sh
```

Opcional:

```bash
sudo ENV_FILE=/ruta/a/.env APP_PORT_FALLBACK=3000 bash ./scripts/install-cron-worker.sh
```

## Qué instala

- Script worker:
  - `/usr/local/bin/shopify-price-cron-worker.sh`
- Servicio systemd one-shot:
  - `shopify-price-cron-worker.service`
- Timer systemd cada minuto:
  - `shopify-price-cron-worker.timer`

## Verificación

```bash
systemctl status shopify-price-cron-worker.timer --no-pager
systemctl list-timers shopify-price-cron-worker.timer --no-pager
journalctl -u shopify-price-cron-worker.service -f
```

## Notas

- El instalador avisa si faltan claves en `.env`.
- Si falta `CRON_SECRET`, aborta para evitar una instalación rota.
