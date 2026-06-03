# ejecutar instalación

sudo APP_NAME="piedrabruja" \
  ENV_FILE="/var/www/html/piedrabruja/.env" \
  APP_PORT_FALLBACK=5000 \
  bash scripts/install-cron-worker.sh


# Logs en vivo
sudo journalctl -u piedrabruja-cron-worker.service -f
https://api.scryfall.com/cards/search?q=set%3Amoc+cn%3A73+lang%3Aen3Amoc+cn%3A73+lang%3Aen

--update-env


# pm2 

pm2 start npm   --name shopify-remix   -- run start