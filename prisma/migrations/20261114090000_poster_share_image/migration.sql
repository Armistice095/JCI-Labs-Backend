-- Variante légère de l'affiche pour l'aperçu des liens partagés (WhatsApp, Facebook) : 1200×630, JPEG.
-- Colonne facultative : les affiches existantes restent valides (l'aperçu utilise alors l'original) ; `npm run posters:share` les complète.
ALTER TABLE "event_posters" ADD COLUMN "share_path" TEXT;
