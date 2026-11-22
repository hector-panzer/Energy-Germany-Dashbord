#!/usr/bin/env python3
"""Lädt die SMARD-Daten für das Energie-Dashboard und schreibt data.json.

Aufruf:  python3 update_smard.py [ausgabe.json]
Benötigt Netzzugriff auf www.smard.de.
"""
import json, sys, urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://www.smard.de/app/chart_data"
H, Q = 3600000, 900000

HOURLY = {  # Schlüssel in data.json : SMARD-Filter-ID (Region DE)
    "braunkohle": 1223, "steinkohle": 4069, "erdgas": 4071, "sonst_konv": 1227,
    "pumpspeicher": 4070, "wind_on": 4067, "wind_off": 1225, "pv": 4068,
    "biomasse": 4066, "wasser": 1226, "sonst_ee": 1228,
    "netzlast": 410, "residuallast": 4359, "nettoexport": 4963,  # 4963 = physikalischer Nettoexport
}
COUNTRIES = {  # physikalische Flüsse DE: (Export-ID, Import-ID); Import-Werte sind negativ
    "Dänemark": (4736, 4880), "Frankreich": (4737, 4881), "Luxemburg": (4738, 4882),
    "Niederlande": (4739, 4883), "Österreich": (4740, 4884), "Polen": (4741, 4885),
    "Schweden": (4742, 4886), "Schweiz": (4743, 4887), "Tschechien": (4744, 4888),
    "Norwegen": (4988, 4990), "Belgien": (4992, 4994),
}
PRICE_ID, PRICE_REGION = 4169, "DE-LU"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "energie-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def series(fid, region="DE", res="hour", weeks=3):
    idx = get_json(f"{BASE}/{fid}/{region}/index_{res}.json")["timestamps"][-weeks:]
    out = {}
    for t in idx:
        for ts, v in get_json(f"{BASE}/{fid}/{region}/{fid}_{region}_{res}_{t}.json")["series"]:
            out[ts] = v
    return out


def main(path):
    maps = {k: series(fid) for k, fid in HOURLY.items()}
    last = max(t for t, v in maps["netzlast"].items() if v is not None)
    n = 7 * 24 + 1
    t0 = last - (n - 1) * H
    hourly = {}
    for k, m in maps.items():
        hourly[k] = [None if m.get(t0 + i * H) is None else int(round(m[t0 + i * H])) for i in range(n)]

    pq = series(PRICE_ID, PRICE_REGION, "quarterhour")
    lastq = max(t for t, v in pq.items() if v is not None)
    nq = (lastq - t0) // Q + 1
    qv = [None if pq.get(t0 + i * Q) is None else round(pq[t0 + i * Q], 2) for i in range(nq)]

    countries = []
    for name, (e_id, i_id) in COUNTRIES.items():
        me, mi = series(e_id), series(i_id)
        e24 = i24 = e7 = i7 = 0.0
        for k in range(n - 1):
            t = t0 + (k + 1) * H
            ev, iv = me.get(t) or 0, mi.get(t) or 0
            e7 += ev; i7 += iv
            if k >= n - 1 - 24:
                e24 += ev; i24 += iv
        countries.append([name, round(e24), round(-i24), round(e7), round(-i7)])

    stand = datetime.now(timezone(timedelta(hours=1))).isoformat(timespec="seconds")
    data = {"stand": stand, "quelle": "SMARD.de – Bundesnetzagentur", "t0": t0, "n": n,
            "hourly": hourly, "price_qh": {"t0": t0, "step": Q, "values": qv}, "countries": countries}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("OK", path, "Erzeugung bis", datetime.fromtimestamp((last + H) / 1000, timezone.utc).isoformat(),
          "Preise bis", datetime.fromtimestamp((lastq + Q) / 1000, timezone.utc).isoformat())


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data.json")
