#!/usr/bin/env python3
"""Daten für den Reiter „Netze“ des Energie-Dashboards.

Läuft täglich als GitHub Action und schreibt Dateien in den Ordner netze/:

  netze/grid_hs.json   Höchstspannungsleitungen (220/380 kV, HGÜ) in Deutschland und Nachbarländern (OpenStreetMap)
  netze/grid_110.json  Hochspannungsleitungen 110 kV in Deutschland (OpenStreetMap)
  netze/orte.json      Umspannwerke und Kraftwerke mit Namen (OpenStreetMap), nur für die Zuordnung
  netze/netze.json     Tägliche Daten: bindende Engpässe (JAO), Grenzkapazitäten (JAO), Redispatch (netztransparenz.de)
  netze/protokoll.txt  Was beim letzten Lauf passiert ist, inkl. nicht zugeordneter Namen

Jeder Teil läuft für sich: Fällt eine Quelle aus, bleiben die alten Daten dieses Teils erhalten.
"""
import csv
import io
import json
import math
import os
import re
import sys
import time
import traceback
import unicodedata
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "netze")
TZ = ZoneInfo("Europe/Berlin")
UA = {"User-Agent": "Energie-Dashboard (github.com/hector-panzer/Energy-Germany-Dashbord)"}
LOG = []
DAYS = 7  # so viele zurückliegende Tage werden gespeichert


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def load_json(name, default=None):
    p = os.path.join(OUT, name)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(name, obj):
    p = os.path.join(OUT, name)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)
    log(f"  gespeichert {name}: {os.path.getsize(p) / 1e6:.2f} MB")


def age_days(name):
    """Alter laut Feld „stand“ in der Datei (Datei-Zeitstempel sind nach git checkout wertlos)."""
    try:
        st = (load_json(name) or {}).get("stand")
        return (datetime.now(timezone.utc) - datetime.fromisoformat(st)).total_seconds() / 86400
    except Exception:
        return 1e9


# ---------------------------------------------------------------- Text-Normalisierung
def fold(s):
    s = s.lower().replace("ß", "ss")
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
        s = s.replace(a, b)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


# ================================================================ 1) OpenStreetMap (über Geofabrik-Auszüge und osmium)
GEOFABRIK = "https://download.geofabrik.de/europe/{}-latest.osm.pbf"
COUNTRIES = ["germany", "netherlands", "belgium", "luxembourg", "france", "switzerland", "austria", "czech-republic", "poland", "denmark"]
BBOX_HS = (45.3, 1.0, 58.2, 21.5)  # Süd, West, Nord, Ost: Ausschnitt für das Ausland
TMP = os.environ.get("RUNNER_TEMP", "/tmp")


def rdp(pts, eps):
    """Douglas-Peucker-Vereinfachung, pts = [(lon, lat), ...]."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    k = math.cos(math.radians(pts[0][1]))
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a][0] * k, pts[a][1]
        bx, by = pts[b][0] * k, pts[b][1]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, py = pts[i][0] * k, pts[i][1]
            if L == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if best > eps * eps:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, kk in zip(pts, keep) if kk]


def encode(pts):
    """Koordinaten als ganze Zahlen (1/1000 Grad), Differenzen: [lon0, lat0, dlon, dlat, ...]."""
    out, px, py = [], 0, 0
    for lon, lat in pts:
        x, y = round(lon * 1000), round(lat * 1000)
        if out and x == px and y == py:
            continue
        out += [x - px, y - py]
        px, py = x, y
    return out


def volts(tag):
    vs = []
    for p in re.split(r"[;,]", tag or ""):
        p = p.strip()
        if p.isdigit():
            vs.append(int(p))
    return vs


def line_row(t, coords, eps):
    vs = volts(t.get("voltage"))
    if not vs or len(coords) < 2:
        return None
    v = max(vs)
    dc = t.get("frequency") == "0" or "hvdc" in (t.get("name", "") + " " + t.get("line", "")).lower()
    cable = t.get("power") == "cable" or t.get("location") in ("underground", "underwater")
    enc = encode(rdp([(c[0], c[1]) for c in coords], eps))
    if len(enc) < 4:
        return None
    flags = (1 if cable else 0) | (2 if dc else 0)
    name = (t.get("name") or t.get("ref") or "")[:70]
    return [round(v / 1000), flags, name, (t.get("operator") or "")[:40], t.get("circuits", ""), enc]


def in_bbox(coords, bb):
    s, w, n, e = bb
    return any(s <= c[1] <= n and w <= c[0] <= e for c in coords)


def centroid(geom):
    t = geom["type"]
    c = geom["coordinates"]
    if t == "Point":
        return c[0], c[1]
    flat = []
    def walk(x):
        if isinstance(x[0], (int, float)):
            flat.append(x)
        else:
            for y in x:
                walk(y)
    walk(c)
    if not flat:
        return None
    return sum(p[0] for p in flat) / len(flat), sum(p[1] for p in flat) / len(flat)


def run(cmd):
    import subprocess
    log("   $", " ".join(cmd))
    subprocess.run(cmd, check=True)


def download(url, path):
    # curl -4: Auf den GitHub-Servern scheitert IPv6 zu Geofabrik („Network is unreachable“)
    run(["curl", "-4", "-fsSL", "--retry", "4", "--retry-delay", "15", "-A", UA["User-Agent"], "-o", path, url])
    log(f"   geladen {url}: {os.path.getsize(path) / 1e9:.2f} GB")


def update_grid(force=False):
    if not force and age_days("grid_hs.json") < 6.5 and age_days("grid_110.json") < 6.5 and age_days("orte.json") < 6.5:
        log("Netzgeometrie: aktuell (jünger als eine Woche), übersprungen")
        return
    log("Netzgeometrie aus OpenStreetMap (Geofabrik) laden …")
    hs, l110, orte = {}, {}, {}
    orte_keys = set()
    for cc in COUNTRIES:
        pbf = os.path.join(TMP, cc + ".osm.pbf")
        flt = os.path.join(TMP, cc + "-power.osm.pbf")
        gj = os.path.join(TMP, cc + "-power.geojsonseq")
        download(GEOFABRIK.format(cc), pbf)
        run(["osmium", "tags-filter", "-O", "-o", flt, pbf, "w/power=line,cable", "nwr/power=substation,plant"])
        os.remove(pbf)
        run(["osmium", "export", "-O", "-f", "geojsonseq", "--add-unique-id=type_id", "-o", gj, flt])
        os.remove(flt)
        n0 = (len(hs), len(l110), len(orte))
        with open(gj, encoding="utf-8") as f:
            for line in f:
                line = line.strip().lstrip("\x1e")
                if not line:
                    continue
                try:
                    ft = json.loads(line)
                except ValueError:
                    continue
                t = ft.get("properties") or {}
                g = ft.get("geometry") or {}
                fid = ft.get("id") or t.get("@id")
                pw = t.get("power")
                if pw in ("line", "cable") and g.get("type") == "LineString":
                    vs = volts(t.get("voltage"))
                    if not vs:
                        continue
                    v = max(vs)
                    coords = g["coordinates"]
                    if v >= 200000:
                        if fid in hs or not (cc == "germany" or in_bbox(coords, BBOX_HS)):
                            continue
                        row = line_row(t, coords, 0.0012)
                        if row:
                            hs[fid] = row
                    elif cc == "germany" and 100000 <= v < 200000:
                        if fid in l110:
                            continue
                        row = line_row(t, coords, 0.0015)
                        if row:
                            l110[fid] = row
                elif pw in ("substation", "plant"):
                    names = [t.get(k) for k in ("name", "name:de", "alt_name", "short_name", "official_name") if t.get(k)]
                    if not names or fid in orte:
                        continue
                    vs = volts(t.get("voltage"))
                    kv = round(max(vs) / 1000) if vs else 0
                    if pw == "substation" and (kv < 100 or (cc != "germany" and kv < 200)):
                        continue
                    c = centroid(g) if g else None
                    if not c:
                        continue
                    lon, lat = c
                    if cc != "germany" and not (BBOX_HS[0] <= lat <= BBOX_HS[2] and BBOX_HS[1] <= lon <= BBOX_HS[3]):
                        continue
                    mw = 0
                    m = re.match(r"([\d.]+)\s*(MW|GW|kW)?", t.get("plant:output:electricity", "") or "")
                    if m:
                        try:
                            mw = float(m.group(1)) * {"GW": 1000, "kW": 0.001}.get(m.group(2), 1)
                        except ValueError:
                            mw = 0
                    okey = (pw, names[0], round(lat, 3), round(lon, 3))
                    if okey in orte_keys:
                        continue
                    orte_keys.add(okey)
                    orte[fid] = ["w" if pw == "plant" else "s", " | ".join(dict.fromkeys(names))[:160], round(lat, 4), round(lon, 4),
                                 kv, round(mw), (t.get("plant:source") or "")[:20], cc[:2]]
        os.remove(gj)
        log(f"  {cc}: +{len(hs) - n0[0]} Leitungen ≥220 kV, +{len(l110) - n0[1]} Leitungen 110 kV, +{len(orte) - n0[2]} Orte")
    stand = datetime.now(timezone.utc).isoformat()
    q = "© OpenStreetMap-Mitwirkende (ODbL), Auszüge von Geofabrik"
    save_json("grid_hs.json", {"quelle": q, "stand": stand, "lines": list(hs.values())})
    save_json("grid_110.json", {"quelle": q, "stand": stand, "lines": list(l110.values())})
    save_json("orte.json", {"quelle": q, "stand": stand, "orte": list(orte.values())})


# ---------------------------------------------------------------- Ortsindex für die Zuordnung
ST_STOP = set("""umspannwerk umspannanlage uw schaltanlage schaltwerk schaltstation station substation poste
transformatorenstation transformatorstation unterwerk kv kraftwerk kw hkw heizkraftwerk grosskraftwerk dampfkraftwerk
tennet amprion 50hertz transnetbw transnet bw westnetz bayernwerk avacon edis e dis netze bw rwe eon uniper enbw vattenfall leag steag
de du la le les the and und an am der die das bei im in von zu sous sur gmbh ag se co plant power station""".split())


def toks(s, stop):
    return [t for t in fold(s).split() if t not in stop and not t.isdigit() and len(t) >= 3]


class Index:
    def __init__(self, orte):
        self.items = []
        self.by_tok = {}
        for o in orte:
            kind, names, lat, lon, kv, mw, src = o[:7]
            for nm in names.split(" | "):
                tk = toks(nm, ST_STOP)
                if not tk:
                    continue
                i = len(self.items)
                self.items.append({"kind": kind, "name": nm, "tk": tk, "key": " ".join(tk), "lat": lat, "lon": lon, "kv": kv, "mw": mw, "src": src})
                for t in set(tk):
                    self.by_tok.setdefault(t, []).append(i)

    def find(self, query, prefer="s", min_kv=0, exact_only=False):
        q = toks(query, ST_STOP)
        if not q:
            return None
        key = " ".join(q)
        cands = set()
        for t in q:
            cands.update(self.by_tok.get(t, []))
        best, bs = None, -1e9
        for i in cands:
            it = self.items[i]
            if it["kind"] == "s" and it["kv"] < min_kv:
                continue
            common = len(set(q) & set(it["tk"]))
            if it["key"] == key:
                score = 100
            elif it["key"].startswith(key + " ") or key.startswith(it["key"] + " "):
                score = 60
            elif common == len(q):
                score = 40
            elif exact_only:
                continue
            elif q[0] in it["tk"]:
                score = 20 + common
            else:
                score = 5 + common
            score -= 0.5 * (len(it["tk"]) - common)
            if it["kind"] == prefer:
                score += 8
            score += min(it["kv"], 400) / 100 + min(it["mw"], 3000) / 1000
            if score > bs:
                best, bs = it, score
        if best is None:
            return None
        return best, bs


# ================================================================ 2) JAO (Flow-Based Market Coupling, Region Core)
JAO = "https://publicationtool.jao.eu/core/api/data/"
DE_TSO = {"Amprion", "TennetGmbh", "TenneTGmbh", "50Hertz", "TransnetBw", "TransnetBW", "50hertz"}


def jao_get(kind, day):
    d0 = datetime(day.year, day.month, day.day, tzinfo=TZ)
    d1 = d0 + timedelta(hours=23, minutes=59)
    params = {"FromUtc": d0.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
              "ToUtc": d1.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    data = []
    skip = 0
    while True:
        p = dict(params, Skip=skip, Take=5000)
        for attempt in range(3):
            r = requests.get(JAO + kind, params=p, headers=UA, timeout=120)
            if r.status_code == 429:
                time.sleep(60)
                continue
            break
        r.raise_for_status()
        j = r.json()
        data += j.get("data", [])
        total = j.get("totalRowsWithFilter", len(data))
        skip += 5000
        if skip >= total or not j.get("data"):
            break
    return data


COLORS = r"\b(black|white|wit|zwart|rood|red|blue|blauw|green|groen|yellow|geel|orange|oranje|grey|grijs|schwarz|weiss|rot|blau|gruen|gelb|grau|braun|violett|lila|nord|sued|ost|west)\b"


def parse_cnec(name):
    """'Diele - Meeden 380 Black' -> ('line', ['Diele', 'Meeden']); 'Sottrum Transformer T421' -> ('trafo', ['Sottrum'])."""
    n = name.strip()
    if n.lower().startswith("external constraint"):
        return "extern", []
    n2 = re.sub(r"\(.*?\)", " ", n)
    low = n2.lower()
    kind = "line"
    if re.search(r"\b(transformer|trafo|tr|pst|phase shifter|ty|t\d{3})\b", low) or re.search(r"\btr\s*\d", low):
        kind = "trafo"
    n2 = re.sub(r"^(l|ln|line|leitung)\s+\d+\s*kv\s*(n0\s*\d+)?", " ", n2, flags=re.I)
    n2 = re.sub(r"\b\d+(/\d+)?\s*(kv)?\b", " ", n2, flags=re.I)
    n2 = re.sub(COLORS, " ", n2, flags=re.I)
    n2 = re.sub(r"\b(transformer|trafo|tr|pst|ty|t\d+|[a-z]?\d+[a-z]?|e|w|n|s|v|x|y|ac|dc|line|leitung|ltg|stk|sk|kabel|cable|vl|vk)\b", " ", n2, flags=re.I)
    n2 = re.sub(r"^\s*y\s*-", " ", n2, flags=re.I)
    parts = [p.strip(" .,_-") for p in re.split(r"\s+-\s+|\s*–\s*|\s+/\s+", n2) if p.strip(" .,_-")]
    if len(parts) == 1 and kind == "line" and "-" in parts[0]:
        sub = [p.strip() for p in parts[0].split("-") if p.strip()]
        if len(sub) == 2:
            parts = sub
    parts = [p for p in parts if len(fold(p)) >= 3]
    if len(parts) >= 2 and fold(parts[0]) == fold(parts[1]):
        kind, parts = "trafo", parts[:1]
    if kind == "trafo":
        parts = parts[:1]
    return kind, parts[:2]


def update_jao(days, idx, prev):
    out = {}
    unmatched = {}
    for day in days:
        ds = day.isoformat()
        try:
            sp = jao_get("shadowPrices", day)
        except Exception as e:
            log(f"  JAO shadowPrices {ds}: {e!r}")
            if prev.get(ds):
                out[ds] = prev[ds]
            continue
        agg = {}
        for d in sp:
            key = (d.get("tso") or "", (d.get("cnecName") or "").strip(), (d.get("contName") or "").strip(), d.get("direction") or "")
            a = agg.get(key)
            if a is None:
                a = agg[key] = {"tso": key[0], "name": key[1], "cont": key[2], "dir": key[3], "eic": d.get("cnecEic") or "",
                                "n": 0, "sum": 0.0, "max": 0.0, "fmax": [], "ram": [], "fref": [], "frm": [], "imax": d.get("imax"),
                                "mrf": d.get("minRamFactor"), "hub": f'{d.get("hubFrom")}>{d.get("hubTo")}', "q": [0] * 100, "ptdf": d.get("maxZ2ZPtdf")}
            spv = float(d.get("shadowPrice") or 0)
            a["n"] += 1
            a["sum"] += spv
            if spv > a["max"]:
                a["max"] = spv
                a["hub"] = f'{d.get("hubFrom")}>{d.get("hubTo")}'
            for k in ("fmax", "ram", "fref", "frm"):
                if d.get(k) is not None:
                    a[k].append(float(d[k]))
            t = datetime.fromisoformat(d["dateTimeUtc"].replace("Z", "+00:00")).astimezone(TZ)
            qi = (t.hour * 60 + t.minute) // 15
            if 0 <= qi < 100:
                a["q"][qi] = round(max(a["q"][qi], spv), 1)
        rows = []
        for a in sorted(agg.values(), key=lambda x: -x["sum"]):
            kind, parts = parse_cnec(a["name"])
            geo = []
            for p in parts:
                m = idx.find(p, prefer="s", min_kv=200, exact_only=False) if idx else None
                if m and m[1] >= 30:
                    geo.append([m[0]["lat"], m[0]["lon"], m[0]["name"]])
                else:
                    geo = None
                    break
            if geo is not None and len(parts) == 2 and len(geo) == 2:
                dkm = math.dist((geo[0][0], geo[0][1] * 0.65), (geo[1][0], geo[1][1] * 0.65)) * 111
                if dkm > 450 or dkm < 0.5:  # unplausibel lang oder gleicher Ort
                    geo = geo[:1] if dkm < 0.5 else None
            if not parts or geo is None:
                if kind != "extern":
                    unmatched[a["name"]] = parts
                geo = []
            avg = lambda v: round(sum(v) / len(v)) if v else None
            de = a["tso"] in DE_TSO or "-DE-" in a["eic"] or a["eic"].startswith("10T-DE")
            rows.append({"tso": a["tso"], "name": a["name"], "cont": a["cont"], "kind": kind, "de": de,
                         "qh": a["n"], "sum": round(a["sum"], 1), "max": round(a["max"], 1),
                         "fmax": avg(a["fmax"]), "ram": avg(a["ram"]), "fref": avg(a["fref"]), "frm": avg(a["frm"]),
                         "imax": a["imax"], "mrf": a["mrf"], "hub": a["hub"], "geo": geo, "q": a["q"][:96]})
        # Grenzen: maximale Austauschkapazität (MaxBex) und geplanter Austausch
        borders = {}
        try:
            mb = jao_get("maxExchanges", day)
            for d in mb:
                for k, v in d.items():
                    if k.startswith("border_") and "DE" in k and v is not None:
                        borders.setdefault(k[7:], {"max": []})["max"].append(float(v))
        except Exception as e:
            log(f"  JAO maxExchanges {ds}: {e!r}")
        try:
            se = jao_get("scheduledExchanges", day)
            for d in se:
                for k, v in d.items():
                    if k.startswith("border_") and "DE" in k.upper() and v is not None:
                        borders.setdefault(k[7:].upper(), {"max": []}).setdefault("sched", []).append(float(v))
        except Exception as e:
            log(f"  JAO scheduledExchanges {ds}: {e!r}")
        bsum = {}
        for k, v in borders.items():
            m = v.get("max", [])
            s_ = v.get("sched", [])
            bsum[k] = {"max_avg": round(sum(m) / len(m)) if m else None, "max_min": round(min(m)) if m else None,
                       "sched_avg": round(sum(s_) / len(s_)) if s_ else None, "sched_max": round(max(s_)) if s_ else None,
                       "n_max": len(m), "n_sched": len(s_)}
        out[ds] = {"cnecs": rows, "borders": bsum, "n_records": len(sp)}
        log(f"  JAO {ds}: {len(sp)} Viertelstunden-Einträge, {len(rows)} bindende Engpässe, {sum(1 for r in rows if r['geo'])} mit Kartenposition")
        time.sleep(2)
    return out, unmatched


# ================================================================ 3) Redispatch (netztransparenz.de)
NT_URL = "https://www.netztransparenz.de/de-de/Systemdienstleistungen/Betriebsfuehrung/Redispatch"
NT_MOD = "dnn$ctr2598$View$"
NT_ID = "dnn_ctr2598_View_"


class FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.fields = []
        self.action = None
        self.in_form = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form" and self.action is None:
            self.action = a.get("action")
            self.in_form = True
        if tag == "input" and a.get("name"):
            t = (a.get("type") or "text").lower()
            if t in ("checkbox", "radio") and "checked" not in a:
                return
            if t in ("submit", "button", "image", "file"):
                return
            self.fields.append([a["name"], a.get("value") or ""])

    def handle_endtag(self, tag):
        if tag == "form":
            self.in_form = False


def redispatch_csv(d_from, d_to):
    s = requests.Session()
    s.headers.update(UA)
    r = s.get(NT_URL, timeout=90)
    r.raise_for_status()
    fp = FormParser()
    fp.feed(r.text)
    f = dict(fp.fields)

    def setdate(which, d):
        iso = d.isoformat()
        f[NT_MOD + which] = iso
        f[NT_MOD + which + "$dateInput"] = d.strftime("%d.%m.%Y")
        cs = f"{NT_ID}{which}_dateInput_ClientState"
        try:
            j = json.loads(f.get(cs) or "{}")
        except ValueError:
            j = {}
        j.update({"enabled": True, "emptyMessage": "", "validationText": iso + "-00-00-00", "valueAsString": iso + "-00-00-00",
                  "lastSetTextBoxValue": d.strftime("%d.%m.%Y")})
        j.setdefault("minDateStr", "2021-01-01-00-00-00")
        j.setdefault("maxDateStr", "2030-12-31-00-00-00")
        f[cs] = json.dumps(j, separators=(",", ":"))

    setdate("FromDatePicker", d_from)
    setdate("ToDatePicker", d_to)
    f["__EVENTTARGET"] = ""
    f["__EVENTARGUMENT"] = ""
    f[NT_MOD + "DownloadCSVButton"] = ""
    action = fp.action or NT_URL
    if action.startswith("/"):
        action = "https://www.netztransparenz.de" + action
    r = s.post(action, data=f, timeout=180)
    r.raise_for_status()
    ctype = r.headers.get("content-type", "")
    if "csv" not in ctype:
        raise RuntimeError(f"keine CSV erhalten ({ctype})")
    raw = r.content
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", "replace")


def num(s):
    s = (s or "").strip().replace(".", "").replace(",", ".") if "," in (s or "") else (s or "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


# Namen, die keinen Ort haben oder die OpenStreetMap anders nennt
RD_FIX = {
    "boerse": None,
    "illwerke vkw": (47.07, 9.93, "Illwerke (Montafon, Vorarlberg)"),
    "kuehtai": (47.21, 11.02, "Kühtai (Tirol)"),
    "silz": (47.27, 10.94, "Silz (Tirol)"),
    "waldeck": (51.18, 9.07, "Pumpspeicherwerk Waldeck"),
    "goldisthal": (50.51, 11.00, "Pumpspeicherwerk Goldisthal"),
}
# Sammelmeldungen ganzer Verteilnetzgebiete (vor allem abgeregelte Wind- und Solaranlagen): nur ungefähre Lage
RD_REGION = [
    (r"^50h mns cr", 51.35, 12.6, "Netzgebiet MITNETZ Strom (Sachsen, Sachsen-Anhalt, Süd-Brandenburg)"),
    (r"^50h edis cr", 53.1, 13.4, "Netzgebiet E.DIS (Brandenburg, Mecklenburg-Vorpommern)"),
    (r"^50h ten cr", 50.9, 11.0, "Netzgebiet TEN (Thüringen)"),
    (r"^50h wema cr", 53.6, 11.5, "Netzgebiet WEMAG (Westmecklenburg)"),
    (r"^50h ava cr", 52.0, 11.6, "Netzgebiet Avacon (Sachsen-Anhalt)"),
    (r"^amp westnetz emsland", 52.7, 7.35, "Netzgebiet Westnetz Emsland"),
    (r"^amp westnetz sauerland", 51.25, 8.2, "Netzgebiet Westnetz Sauerland"),
]
RD_STOP = ST_STOP | set("""block blk gt dt gud gtkw standort gesamt netzreservekraftwerk reservekraftwerk reservekw reserve kapres sysrel bnbm
cluster ava shn 50h amp cr sonstige konventionell kwk owp wp pv ee eeg pool sw kmw kraftwerke hkwm infra ikw
btb bhkw pth guds dampf hkw heizkraftwerk modul anlage anlagen kessel turbine ost west nord sued mitte""".split())


def rd_tokens(name):
    s = re.sub(r"[_]", " ", name)
    return [t for t in fold(s).split() if t not in RD_STOP and not t.isdigit() and len(t) >= 4 and not re.fullmatch(r"[a-z]?\d+[a-z]?", t)]


def rd_locate(name, energy, idx, cache):
    if name in cache:
        return cache[name]
    f = fold(name)
    for rx, la, lo, nm in RD_REGION:
        if re.search(rx, f):
            cache[name] = (la, lo, nm, 1)
            return cache[name]
    for k, v in RD_FIX.items():
        if k in f:
            cache[name] = v
            return v
    res = None
    if idx:
        tk = rd_tokens(name)
        prefer = "w" if energy == "Konventionell" or re.search(r"(kraftwerk|kw|block|gt|gud|owp|offshore|wp )", name, re.I) else "s"
        if re.match(r"^(uw|50h uw|ava|shn|umspann)", name, re.I) or "cluster" in name.lower():
            prefer = "s"
        cand = None
        if tk:
            m = idx.find(" ".join(tk), prefer=prefer)
            if m and m[1] >= 30:
                cand = m
            else:
                for t in tk:
                    m = idx.find(t, prefer=prefer, exact_only=False)
                    if m and (t in m[0]["tk"]) and (cand is None or m[1] > cand[1]):
                        cand = m
                        break
        if cand:
            it = cand[0]
            res = (it["lat"], it["lon"], it["name"])
    cache[name] = res
    return res


def update_redispatch(days, idx, prev):
    d_from, d_to = days[0], days[-1]
    txt = redispatch_csv(d_from, d_to)
    rdr = csv.reader(io.StringIO(txt), delimiter=";")
    head = next(rdr)
    H = {h.strip(): i for i, h in enumerate(head)}
    need = ["BEGINN_DATUM", "RICHTUNG", "GESAMTE_ARBEIT_MWH", "BETROFFENE_ANLAGE", "PRIMAERENERGIEART", "GRUND_DER_MASSNAHME"]
    for n in need:
        if n not in H:
            raise RuntimeError(f"Spalte {n} fehlt: {head}")
    per_day = {}
    cache = {}
    unmatched = {}
    nrows = 0
    for row in rdr:
        if len(row) < len(head):
            continue
        nrows += 1
        try:
            dd = datetime.strptime(row[H["BEGINN_DATUM"]].strip(), "%d.%m.%Y").date().isoformat()
        except ValueError:
            continue
        grund = row[H["GRUND_DER_MASSNAHME"]].strip()
        richt = row[H["RICHTUNG"]].strip().lower()
        up = "erh" in richt
        mwh = num(row[H["GESAMTE_ARBEIT_MWH"]])
        mw = num(row[H["MAXIMALE_LEISTUNG_MW"]]) if "MAXIMALE_LEISTUNG_MW" in H else 0
        anlage = row[H["BETROFFENE_ANLAGE"]].strip()
        pe = row[H["PRIMAERENERGIEART"]].strip()
        uenb = row[H["ANWEISENDER_UENB"]].strip() if "ANWEISENDER_UENB" in H else ""
        D = per_day.setdefault(dd, {"plants": {}, "tot": {"up": 0, "down": 0, "ct": 0, "probe": 0, "n": 0}, "pe": {}})
        tot = D["tot"]
        tot["n"] += 1
        if "probe" in grund.lower():
            tot["probe"] += mwh
            continue
        if "countertrade" in grund.lower():
            tot["ct"] += mwh
        if up:
            tot["up"] += mwh
        else:
            tot["down"] += mwh
        pk = pe + ("+" if up else "-")
        D["pe"][pk] = D["pe"].get(pk, 0) + mwh
        p = D["plants"].setdefault(anlage, {"name": anlage, "pe": pe, "uenb": uenb, "up": 0, "down": 0, "maxmw": 0, "n": 0, "grund": set()})
        p["up" if up else "down"] += mwh
        p["maxmw"] = max(p["maxmw"], mw)
        p["n"] += 1
        p["grund"].add(grund)
    out = {}
    for dd, D in per_day.items():
        plants = []
        for p in D["plants"].values():
            loc = rd_locate(p["name"], p["pe"], idx, cache)
            if loc is None and fold(p["name"]) not in ("boerse",):
                unmatched[p["name"]] = unmatched.get(p["name"], 0) + p["up"] + p["down"]
            plants.append({"name": p["name"], "pe": p["pe"], "uenb": p["uenb"], "up": round(p["up"]), "down": round(p["down"]),
                           "maxmw": round(p["maxmw"]), "n": p["n"], "grund": sorted(p["grund"]),
                           "geo": [loc[0], loc[1], loc[2], loc[3] if len(loc) > 3 else 0] if loc else None})
        plants.sort(key=lambda x: -(x["up"] + x["down"]))
        out[dd] = {"plants": plants, "tot": {k: round(v) for k, v in D["tot"].items()}, "pe": {k: round(v) for k, v in D["pe"].items()}}
    log(f"  Redispatch {d_from}–{d_to}: {nrows} Maßnahmen, Tage mit Daten: {sorted(out)}")
    for k in prev:
        if k not in out and k >= (d_from - timedelta(days=1)).isoformat():
            out[k] = prev[k]
    return out, unmatched, cache


# ================================================================ Hauptprogramm
def main():
    os.makedirs(OUT, exist_ok=True)
    force_grid = "--grid" in sys.argv
    t0 = time.time()
    log("Lauf gestartet", datetime.now(timezone.utc).isoformat())
    try:
        update_grid(force_grid)
    except Exception:
        log("FEHLER Netzgeometrie:\n" + traceback.format_exc())
    orte = (load_json("orte.json") or {}).get("orte", [])
    idx = Index(orte) if orte else None
    log(f"Ortsindex: {len(idx.items) if idx else 0} Namen")

    prev = load_json("netze.json") or {}
    today = datetime.now(TZ).date()
    days = [today - timedelta(days=i) for i in range(DAYS, 0, -1)]  # die letzten 7 vollständigen Tage
    res = {"stand": datetime.now(timezone.utc).isoformat(), "tage": [d.isoformat() for d in days]}

    log("JAO laden …")
    try:
        jao, jao_unm = update_jao(days, idx, prev.get("jao", {}))
        res["jao"] = jao
    except Exception:
        log("FEHLER JAO:\n" + traceback.format_exc())
        res["jao"] = prev.get("jao", {})
        jao_unm = {}

    log("Redispatch laden …")
    rd_cache = {}
    try:
        rd, rd_unm, rd_cache = update_redispatch(days, idx, prev.get("redispatch", {}))
        res["redispatch"] = rd
    except Exception:
        log("FEHLER Redispatch:\n" + traceback.format_exc())
        res["redispatch"] = prev.get("redispatch", {})
        rd_unm = {}
    keep = set(res["tage"])
    for k in ("jao", "redispatch"):
        res[k] = {d: v for d, v in res[k].items() if d in keep}
    save_json("netze.json", res)

    LOG.append("")
    LOG.append("== Redispatch: Zuordnung der Anlagen ==")
    for n, loc in sorted(rd_cache.items()):
        LOG.append(f"  {n}  ->  {loc[2] + f' ({loc[0]}, {loc[1]})' if loc else '— kein Ort —'}")
    LOG.append("== Redispatch: ohne Ort (MWh im Zeitraum) ==")
    for n, v in sorted(rd_unm.items(), key=lambda x: -x[1]):
        LOG.append(f"  {round(v):>8}  {n}")
    LOG.append("== JAO: Engpässe ohne Kartenposition ==")
    for n, p in sorted(jao_unm.items()):
        LOG.append(f"  {n}   (gelesen als {p})")
    LOG.append("== JAO: Zuordnung ==")
    for d, v in sorted(res["jao"].items())[-1:]:
        for c in v.get("cnecs", []):
            LOG.append(f"  {c['name']}  ->  {[g[2] for g in c['geo']]}")
    log(f"Fertig in {time.time() - t0:.0f} s")
    with open(os.path.join(OUT, "protokoll.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(LOG) + "\n")


if __name__ == "__main__":
    main()
