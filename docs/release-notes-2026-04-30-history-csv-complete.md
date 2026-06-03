# Version 2026-04-30 - Historial CSV completo

## Cambios incluidos

- Se separo la generacion del CSV a `app/services/sync-history-csv.server.ts`.
- La ruta `app/routes/app.price-sync.history-csv.tsx` queda solo como endpoint: autentica, obtiene la corrida y responde el archivo.
- Las variantes escaneables sin coincidencia en Scryfall ahora tambien se guardan en el historial por item, en todos los modos de busqueda.
- El historial sigue respetando el filtro de escaneables: si el metodo usa meta/custom field, el valor debe existir y no estar vacio.
- En el CSV esas filas salen como `No encontrada`, con `Encontrada en Scryfall = No`, en vez de desaparecer del archivo.
- Esto corrige el caso donde el historial mostraba una corrida con miles de cartas escaneadas, pero la descarga incluia solo las filas que tenian resultado persistido.
- El CSV agrega `Precio anterior` y `Precio actual aplicado`; cuando es posible, lee `custom.previous_price` desde Shopify para mostrar el respaldo real.
- Si una fila antigua quedo como `Sin cambios` pero el respaldo `custom.previous_price` difiere del precio actual aplicado, el CSV la muestra como `Actualizado`.
- En corridas programadas por bloques, los productos ya procesados durante la misma corrida se excluyen de los siguientes bloques para evitar que un update cambie `updatedAt`, vuelva a entrar y pise `Actualizado` con `Sin cambios`.
- Si aun aparece un duplicado en el historial, el merge conserva estados de mayor impacto como `Actualizado`, `Fallo` o `Sospechosa` por encima de `Sin cambios`.
- El cambio aplica para corridas nuevas; las corridas antiguas no tienen los items omitidos guardados en base de datos y no se pueden reconstruir con detalle desde el CSV.

## Archivos principales

- `app/services/sync-history-csv.server.ts`
- `app/routes/app.price-sync.history-csv.tsx`
- `app/services/price-sync.server.ts`

## Verificacion

- `npm run lint`
- `npm run build`
