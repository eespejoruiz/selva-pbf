# selva-pbf

Landings del stand S92 de Selva en el Perú Business Fest 2026, servidas en
selvagencia.com/pbf-seo y /pbf-dev (Traefik en escudo → motor:3095).

- `server.js`: servidor sin dependencias (Node 20). Diagnóstico SEO/GEO y de
  desarrollo en vivo, candados (código por correo, 1 análisis cada 30 días),
  envío del resultado por correo (Resend) y WhatsApp (Evolution), carga en
  Selva Boost y el bot del QR de WhatsApp del stand (`/pbf-api/wa-hook`).
- `public/`: las dos landings.
- Datos (fuera del repo): `/srv/selva-pbf-data` (leads.jsonl, jobs/, wa.json,
  stand.key, master.code, hook.key). Secretos en `.env` (fuera del repo).
- Reiniciar sin cortar análisis en curso: `/root/pbf_safe_restart.sh [server.js nuevo]`.
