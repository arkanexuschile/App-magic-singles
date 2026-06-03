#!/bin/bash
cd /var/www/html/piedrabruja
export PORT=5000
exec npx remix-serve build/server/index.js