# Strom in Deutschland – Energie-Dashboard

Ein kleines Dashboard für den deutschen Strommarkt: Erzeugung nach Energieträgern, Netzlast, Residuallast, Day-Ahead-Preise, Import/Export und eine Merit-Order-Schätzung.

- Die Seite lädt die Daten beim Öffnen direkt von [SMARD.de](https://www.smard.de) (Bundesnetzagentur, CC BY 4.0).
- `data.json` ist nur ein Ersatz-Datenstand, falls SMARD nicht erreichbar ist (`update_smard.py` erzeugt ihn neu).
- Läuft als statische Seite auf GitHub Pages.
