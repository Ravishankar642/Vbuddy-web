import { useCallback, useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AtcStation, NetPilot } from "@vbuddy/protocol";
import type { BridgeSnapshot } from "../lib/bridge-client";
import { useBridgeActions } from "../lib/useBridge";
import { apiFetch } from "../lib/api";
import { track, type TrackPoint } from "../lib/track";
import { attachGround } from "./GroundLayer";

/** Weather on the map: off, rain radar, or rain radar plus clouds. */
export type WeatherMode = "off" | "rain" | "clouds";

/** A tile layer whose tiles come from the bridge's API (through the relay they need the pairing token). */
const AuthTileLayer = L.TileLayer.extend({
  createTile(this: L.TileLayer, coords: L.Coords, done: L.DoneCallback) {
    const img = document.createElement("img");
    img.alt = "";
    void apiFetch(this.getTileUrl(coords))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b) return done(undefined, img);
        img.onload = () => {
          URL.revokeObjectURL(img.src);
          done(undefined, img);
        };
        img.onerror = () => done(undefined, img);
        img.src = URL.createObjectURL(b);
      })
      .catch((e: Error) => done(e, img));
    return img;
  },
}) as unknown as new (url: string, o: L.TileLayerOptions) => L.TileLayer;

const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
import { hdg, int } from "../lib/format";
import { mapBus } from "../lib/mapbus";
import type { MapStyle } from "../lib/mapstyle";

// Esri map tiles: no API key needed. Satellite imagery (darkened in CSS) with place names and borders on top, or the grey canvases.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const tilesFor = (style: MapStyle) =>
  style === "satellite"
    ? { base: `${ESRI}World_Imagery/MapServer/tile/{z}/{y}/{x}`, labels: `${ESRI}Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, native: 17 }
    : {
        base: `${ESRI}Canvas/World_${style === "dark" ? "Dark" : "Light"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
        labels: `${ESRI}Canvas/World_${style === "dark" ? "Dark" : "Light"}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
        native: 16,
      };
const TRACK_COLOR = { dark: "#ff8fb8", light: "#b3125f" } as const;
const TILE_ATTR = '&copy; <a href="https://www.esri.com">Esri</a>';
const PLANE = "M32 10 L36 28 L54 36 L54 40 L36 36 L35 48 L41 52 L41 55 L32 52 L23 55 L23 52 L29 48 L28 36 L10 40 L10 36 L28 28 Z";
const VIEW_KEY = "vbuddy.map.view";
const LABEL_ZOOM = 7;
const SECTOR_LABEL_ZOOM = 5;
const EXTRAPOLATE_MAX_S = 30;

const COLORS = { ctr: "#3987e5", fss: "#3987e5", app: "#b07de0", twr: "#e0a84f" } as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const planeIcon = (cls: string, size: number, label?: string) =>
  L.divIcon({
    className: "ac-wrap",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="ac ${cls}"><svg class="ac__icon" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path d="${PLANE}"/></svg>${label ? `<span class="ac__label">${esc(label)}</span>` : ""}</div>`,
  });
function rotate(m: L.Marker, deg: number) {
  const svg = m.getElement()?.querySelector<SVGElement>(".ac__icon");
  if (svg) svg.style.transform = `rotate(${deg}deg)`;
}
const R_NM = 3440.065;
function project(lat: number, lon: number, brg: number, nm: number): [number, number] {
  const d = nm / R_NM, p1 = (lat * Math.PI) / 180, b = (brg * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = (lon * Math.PI) / 180 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (((l2 * 180) / Math.PI + 540) % 360) - 180];
}


function distNm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance from your aircraft when the sim is running; otherwise from the map's centre (what the bridge measured). */
let ownPos: { lat: number; lon: number } | null = null;
const away = (p: NetPilot) => (ownPos ? distNm(ownPos.lat, ownPos.lon, p.lat, p.lon) : p.distNm);

function pilotPopup(p: NetPilot) {
  const route = p.dep || p.arr ? `${esc(p.dep ?? "?")} → ${esc(p.arr ?? "?")}` : "No flight plan";
  return `<div class="pop"><b>${esc(p.callsign)}</b>${p.type ? ` <span class="pop__muted">${esc(p.type)}</span>` : ""}<br>${route}<br>${int(p.alt)} ft · ${int(p.gs)} kt · ${hdg(p.hdg)}°<br><span class="pop__muted">${int(away(p))} nm ${ownPos ? "from you" : "from map centre"}</span></div>`;
}
function stationLines(list: AtcStation[]) {
  return list
    .map((s) => `<div><b>${esc(s.freq)}</b> ${esc(s.name)} <span class="pop__muted">${esc(s.callsign)}</span>${s.atisCode ? ` <span class="pop__muted">ATIS ${esc(s.atisCode)}</span>` : ""}</div>`)
    .join("");
}

function loadView(): { center: [number, number]; zoom: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    return v && Array.isArray(v.center) && typeof v.zoom === "number" ? v : null;
  } catch {
    return null;
  }
}
function saveView(map: L.Map) {
  try {
    const c = map.getCenter();
    localStorage.setItem(VIEW_KEY, JSON.stringify({ center: [c.lat, c.lng], zoom: map.getZoom() }));
  } catch {
    /* not important */
  }
}

/** Boundary shapes already fetched from the bridge, by id. Kept across tab switches. */
const shapes = new Map<string, GeoJSON.Feature>();

interface Layers {
  own: L.Marker | null;
  track: L.Polyline;
  traffic: L.LayerGroup;
  sectors: L.LayerGroup;
  labels: L.LayerGroup;
  airports: L.LayerGroup;
}

export interface MapViewProps {
  b: BridgeSnapshot;
  follow: boolean;
  onFollow: (v: boolean) => void;
  showTraffic: boolean;
  showSectors: boolean;
  /** Pixels at the bottom/left of the map that the sheet covers, so the aircraft is centred in what is left. */
  inset: { bottom: number; left: number };
  mapStyle: MapStyle;
  weather?: WeatherMode;
}

export default function MapView({ b, follow, onFollow, showTraffic, showSectors, inset, mapStyle, weather = "off" }: MapViewProps) {
  const { setTrafficArea } = useBridgeActions();
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const lay = useRef<Layers | null>(null);
  const styleRef = useRef(mapStyle);
  styleRef.current = mapStyle;
  const baseLayer = useRef<L.TileLayer | null>(null);
  const labelLayer = useRef<L.TileLayer | null>(null);
  useEffect(() => {
    const t = tilesFor(mapStyle);
    baseLayer.current?.setUrl(t.base);
    labelLayer.current?.setUrl(t.labels);
    if (baseLayer.current) baseLayer.current.options.maxNativeZoom = t.native;
    if (labelLayer.current) labelLayer.current.options.maxNativeZoom = t.native;
    lay.current?.track.setStyle({ color: TRACK_COLOR[mapStyle === "light" ? "light" : "dark"] });
    const c = el.current;
    if (c) {
      c.classList.toggle("map--sat", mapStyle === "satellite");
      c.classList.toggle("map--light", mapStyle === "light");
    }
  }, [mapStyle]);
  const followRef = useRef(follow);
  followRef.current = follow;
  const insetRef = useRef(inset);
  insetRef.current = inset;
  const onFollowRef = useRef(onFollow);
  onFollowRef.current = onFollow;
  /** Where to centre the map so `ll` lands in the middle of the part the sheet leaves free. */
  const centreFor = (map: L.Map, ll: L.LatLngExpression, zoom = map.getZoom()): L.LatLng => {
    const size = map.getSize();
    const i = insetRef.current;
    const visX = i.left + (size.x - i.left) / 2;
    const visY = (size.y - i.bottom) / 2;
    return map.unproject(map.project(ll, zoom).add([size.x / 2 - visX, size.y / 2 - visY]), zoom);
  };
  const [shapesVersion, setShapesVersion] = useState(0);
  const trafficMarks = useRef(new Map<string, { m: L.Marker; p: NetPilot }>());
  const trafficAt = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);

  const lastArea = useRef<{ c: L.LatLng; r: number } | null>(null);
  /** Tells the bridge where the map is, unless it has barely moved since last time. */
  const sendArea = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const r = Math.min(1000, Math.max(20, (c.distanceTo(map.getBounds().getNorthEast()) / 1852) * 1.1));
    const last = lastArea.current;
    if (last && c.distanceTo(last.c) / 1852 < last.r * 0.15 && Math.abs(r - last.r) / last.r < 0.15) return;
    lastArea.current = { c, r };
    setTrafficArea(c.lat, c.lng, r);
  }, [setTrafficArea]);

  /* ---- create the map once ---- */
  useEffect(() => {
    const t = b.latest?.data;
    const saved = loadView();
    const map = L.map(el.current!, {
      zoomControl: false,
      worldCopyJump: true,
      preferCanvas: false,
      center: t ? [t.lat, t.lon] : (saved?.center ?? [20, 0]),
      zoom: t ? Math.max(saved?.zoom ?? 8, 6) : (saved?.zoom ?? 3),
    });
    mapRef.current = map;
    map.attributionControl.setPosition("bottomright");
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    const tiles = tilesFor(styleRef.current);
    el.current?.classList.toggle("map--sat", styleRef.current === "satellite");
    baseLayer.current = L.tileLayer(tiles.base, { attribution: TILE_ATTR, maxNativeZoom: tiles.native, maxZoom: 18 }).addTo(map);
    // Place names above the aircraft-free ground, below markers.
    map.createPane("basemapLabels").style.zIndex = "250";
    // Rain and clouds: over the ground, under the place names and everything else.
    map.createPane("weather").style.zIndex = "240";
    map.getPane("weather")!.style.pointerEvents = "none";
    labelLayer.current = L.tileLayer(tiles.labels, { pane: "basemapLabels", maxNativeZoom: tiles.native, maxZoom: 18, opacity: 0.95 }).addTo(map);

    const layers: Layers = {
      own: null,
      track: L.polyline(
        track.points().map((p) => [p[0], p[1]] as [number, number]),
        { color: TRACK_COLOR[styleRef.current === "light" ? "light" : "dark"], weight: 2.5, opacity: 0.9, interactive: false },
      ).addTo(map),
      sectors: L.layerGroup().addTo(map),
      labels: L.layerGroup().addTo(map),
      airports: L.layerGroup().addTo(map),
      traffic: L.layerGroup().addTo(map),
    };
    lay.current = layers;

    const zoomClass = () => {
      el.current?.classList.toggle("map--labels", map.getZoom() >= LABEL_ZOOM);
      el.current?.classList.toggle("map--sector-labels", map.getZoom() >= SECTOR_LABEL_ZOOM);
    };
    zoomClass();
    let areaTimer = 0;
    map.on("zoomend", zoomClass);
    map.on("dragstart", () => onFollowRef.current(false));
    map.on("moveend", () => {
      saveView(map);
      // Throttled, not debounced: while following the aircraft the map never stops moving.
      if (!areaTimer)
        areaTimer = window.setTimeout(() => {
          areaTimer = 0;
          sendArea();
        }, 700);
    });
    sendArea();
    // The container may still be settling its size on first paint.
    const sizeTimer = setTimeout(() => map.invalidateSize(), 100);

    const unsub = track.subscribe((added, reset) => {
      if (reset) layers.track.setLatLngs(track.points().map((p) => [p[0], p[1]] as [number, number]));
      else for (const p of added as TrackPoint[]) layers.track.addLatLng([p[0], p[1]]);
    });

    return () => {
      unsub();
      clearTimeout(areaTimer);
      clearTimeout(sizeTimer);
      trafficMarks.current.clear();
      map.remove();
      mapRef.current = null;
      lay.current = null;
    };
  }, [sendArea]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (b.sessionId) void track.loadSessionHistory(b.sessionId);
  }, [b.sessionId]);

  /* ---- the SimBrief route of the flight in progress ---- */
  const planKey = b.plan ? `${b.plan.ofpId}:${b.plan.fixes.length}:${b.plan.matched}` : "";
  useEffect(() => {
    const map = mapRef.current;
    const p = b.plan;
    if (!map || !p || p.fixes.length < 2) return;
    const pts = p.fixes.map((f) => [f.lat, f.lon] as [number, number]);
    const ends = (at: [number, number], icao: string) =>
      L.marker(at, { icon: L.divIcon({ className: "plan-end", html: `<span>${icao}</span>`, iconSize: [0, 0] }), interactive: false, keyboard: false });
    const g = L.layerGroup([
      L.polyline(pts, { className: `plan-line${p.matched ? "" : " plan-line--other"}`, weight: 3, opacity: 0.9, interactive: false, dashArray: "8 7" }),
      ends(pts[0]!, p.dep),
      ends(pts[pts.length - 1]!, p.arr),
    ]).addTo(map);
    return () => {
      g.remove();
    };
  }, [planKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- weather: RainViewer radar (no key), and clouds from OpenWeatherMap through the bridge ---- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || weather === "off") return;
    let cancelled = false;
    let radar: L.TileLayer | null = null;
    const loadRadar = async () => {
      try {
        const j = (await (await fetch(RAINVIEWER)).json()) as { host?: string; radar?: { past?: Array<{ path: string }> } };
        const last = j.radar?.past?.[j.radar.past.length - 1];
        if (cancelled || !j.host || !last) return;
        const url = `${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`;
        if (radar) radar.setUrl(url);
        else radar = L.tileLayer(url, { pane: "weather", opacity: 0.75, maxNativeZoom: 7, maxZoom: 18, attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>' }).addTo(map);
      } catch {
        /* radar unavailable for now: the next refresh tries again */
      }
    };
    void loadRadar();
    const timer = window.setInterval(() => void loadRadar(), 10 * 60_000);
    const clouds = weather === "clouds" ? new AuthTileLayer("/api/weather/clouds/{z}/{x}/{y}.png", { pane: "weather", opacity: 0.85, maxNativeZoom: 9, maxZoom: 18, attribution: '<a href="https://openweathermap.org/">OpenWeatherMap</a>' }).addTo(map) : null;
    return () => {
      cancelled = true;
      clearInterval(timer);
      radar?.remove();
      clouds?.remove();
    };
  }, [weather]);

  /* ---- own aircraft ---- */
  const t = b.latest?.data;
  ownPos = t ? { lat: t.lat, lon: t.lon } : null;
  useEffect(() => {
    const map = mapRef.current;
    const layers = lay.current;
    if (!map || !layers || !t) return;
    if (!layers.own) {
      layers.own = L.marker([t.lat, t.lon], { icon: planeIcon("ac--own", 30), keyboard: false, zIndexOffset: 1000, interactive: false }).addTo(map);
    } else layers.own.setLatLng([t.lat, t.lon]);
    rotate(layers.own, t.hdgTrue);
    if (followRef.current) map.panTo(centreFor(map, [t.lat, t.lon]), { animate: true, duration: 0.25, noMoveStart: true });
  }, [t]);

  useEffect(() => {
    const map = mapRef.current;
    if (follow && map && t) {
      const z = Math.max(map.getZoom(), 7);
      map.setView(centreFor(map, [t.lat, t.lon], z), z);
    }
  }, [follow]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- traffic ---- */
  useEffect(() => {
    const layers = lay.current;
    if (!layers) return;
    const pilots = b.traffic?.pilots ?? [];
    const marks = trafficMarks.current;
    const keep = new Set<string>();
    for (const p of pilots) {
      keep.add(p.callsign);
      const cur = marks.get(p.callsign);
      if (cur) {
        cur.p = p;
        cur.m.setLatLng([p.lat, p.lon]);
        cur.m.setPopupContent(pilotPopup(p));
      } else {
        const m = L.marker([p.lat, p.lon], { icon: planeIcon("ac--traffic", 28, p.callsign), keyboard: false, title: p.callsign })
          .bindPopup(pilotPopup(p), { closeButton: false, autoPan: false })
          .on("popupopen", () => setSelected(p.callsign))
          .on("popupclose", () => setSelected((s) => (s === p.callsign ? null : s)))
          .addTo(layers.traffic);
        marks.set(p.callsign, { m, p });
      }
      rotate(marks.get(p.callsign)!.m, p.hdg);
    }
    for (const [cs, { m }] of marks) {
      if (!keep.has(cs)) {
        layers.traffic.removeLayer(m);
        marks.delete(cs);
      }
    }
    trafficAt.current = b.traffic?.receivedAt ?? 0;
  }, [b.traffic]);

  // Between network updates (every 15 s), move traffic along its heading so it doesn't jump.
  useEffect(() => {
    const id = setInterval(() => {
      const age = Math.min(EXTRAPOLATE_MAX_S, (Date.now() - trafficAt.current) / 1000);
      if (age <= 0) return;
      for (const { m, p } of trafficMarks.current.values()) {
        if (p.gs < 40) continue;
        m.setLatLng(project(p.lat, p.lon, p.hdg, (p.gs * age) / 3600));
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    for (const [cs, { m }] of trafficMarks.current) m.getElement()?.querySelector(".ac")?.classList.toggle("ac--sel", cs === selected);
  }, [selected, b.traffic]);

  /* ---- ATC sectors and airports ---- */
  useEffect(() => {
    const missing = [...new Set(b.stations.map((s) => s.boundaryId).filter((id): id is string => !!id && !shapes.has(id)))];
    if (!missing.length || b.link !== "open") return;
    let cancelled = false;
    void (async () => {
      try {
        for (let i = 0; i < missing.length; i += 100) {
          const res = await apiFetch(`/api/network/boundaries?ids=${encodeURIComponent(missing.slice(i, i + 100).join(","))}`);
          if (!res.ok) return;
          const fc = (await res.json()) as GeoJSON.FeatureCollection;
          for (const f of fc.features) shapes.set(String(f.properties?.id), f);
        }
        if (!cancelled) setShapesVersion((v) => v + 1);
      } catch {
        /* try again on the next station update */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [b.stations, b.link]);

  const currentCs = b.atc?.current?.callsign ?? null;
  useEffect(() => {
    const layers = lay.current;
    if (!layers) return;
    layers.sectors.clearLayers();
    layers.labels.clearLayers();
    layers.airports.clearLayers();

    // Bigger areas first so smaller ones stay clickable on top.
    const withShape = b.stations.filter((s) => s.boundaryId && shapes.has(s.boundaryId));
    const byShape = new Map<string, AtcStation[]>();
    for (const s of withShape) byShape.set(s.boundaryId!, [...(byShape.get(s.boundaryId!) ?? []), s]);
    const order = [...byShape.entries()].sort(([, a], [, b2]) => (a[0]!.facility === "ctr" || a[0]!.facility === "fss" ? 0 : 1) - (b2[0]!.facility === "ctr" || b2[0]!.facility === "fss" ? 0 : 1));
    for (const [id, list] of order) {
      const f = list[0]!.facility as keyof typeof COLORS;
      const isCur = list.some((s) => s.callsign === currentCs);
      const color = COLORS[f] ?? COLORS.ctr;
      L.geoJSON(shapes.get(id)!, {
        style: { color, weight: isCur ? 3 : 1.2, opacity: isCur ? 1 : 0.75, fillColor: color, fillOpacity: isCur ? 0.14 : 0.04 },
      })
        .bindTooltip(`<div class="pop">${stationLines(list)}</div>`, { sticky: true, direction: "top", opacity: 1 })
        .addTo(layers.sectors);
    }

    // Sector labels for centres (callsign + frequency at the sector's label point).
    for (const s of b.stations) {
      if ((s.facility !== "ctr" && s.facility !== "fss") || s.lat === null || s.lon === null) continue;
      L.marker([s.lat, s.lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "seclabel-wrap", iconSize: [0, 0], html: `<div class="seclabel${s.callsign === currentCs ? " seclabel--cur" : ""}">${esc(s.callsign)}<br><b>${esc(s.freq)}</b></div>` }),
      }).addTo(layers.labels);
    }

    // Airports: one badge per airport with a letter per online position.
    const apts = new Map<string, { lat: number; lon: number; icao: string; list: AtcStation[] }>();
    for (const s of b.stations) {
      if (s.facility === "ctr" || s.facility === "fss" || s.lat === null || s.lon === null) continue;
      const key = `${s.lat.toFixed(3)},${s.lon.toFixed(3)}`;
      const a = apts.get(key) ?? { lat: s.lat, lon: s.lon, icao: s.callsign.split("_")[0]!, list: [] };
      a.list.push(s);
      apts.set(key, a);
    }
    const LETTER: Record<string, string> = { del: "D", gnd: "G", twr: "T", app: "A" };
    for (const a of apts.values()) {
      const letters = ["del", "gnd", "twr", "app"].filter((f) => a.list.some((s) => s.facility === f));
      const cur = a.list.some((s) => s.callsign === currentCs);
      const atis = a.list.find((s) => s.atisCode);
      L.marker([a.lat, a.lon], {
        keyboard: false,
        title: a.icao,
        icon: L.divIcon({
          className: "apt-wrap",
          iconSize: [0, 0],
          html: `<div class="apt${cur ? " apt--cur" : ""}"><b>${esc(a.icao)}</b>${letters.map((f) => `<span class="apt__f apt__f--${f}">${LETTER[f]}</span>`).join("")}${atis ? `<span class="apt__f apt__f--atis">${esc(atis.atisCode!)}</span>` : ""}</div>`,
        }),
      })
        .bindPopup(`<div class="pop">${stationLines(a.list)}${atis?.atis?.length ? `<div class="pop__atis">${esc(atis.atis.join(" "))}</div>` : ""}</div>`, { closeButton: false, maxWidth: 300 })
        .addTo(layers.airports);
    }
  }, [b.stations, shapesVersion, currentCs]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = lay.current;
    if (!map || !layers) return;
    const set = (group: L.LayerGroup, on: boolean) => (on ? group.addTo(map) : map.removeLayer(group));
    set(layers.traffic, showTraffic);
    set(layers.sectors, showSectors);
    set(layers.labels, showSectors);
    set(layers.airports, showSectors);
  }, [showTraffic, showSectors]);

  // The sheet's size changes what part of the map is visible.
  useEffect(() => {
    const map = mapRef.current;
    const tt = b.latest?.data;
    if (map && followRef.current && tt) map.panTo(centreFor(map, [tt.lat, tt.lon]), { animate: false });
  }, [inset.bottom, inset.left]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let route: L.LayerGroup | null = null;
    const clear = () => {
      route?.remove();
      route = null;
    };
    mapBus.showRoute = (pts) => {
      const map = mapRef.current;
      clear();
      if (!map || !pts || pts.length < 2) return;
      onFollowRef.current(false);
      const mark = (at: [number, number], label: string) =>
        L.circleMarker(at, { radius: 6, color: "#fff", weight: 2, fillColor: label === "A" ? "#2fbf71" : "#c8243f", fillOpacity: 1, interactive: false });
      route = L.layerGroup([
        L.polyline(pts, { color: "#ff5d73", weight: 4, opacity: 0.95, interactive: false }),
        mark(pts[0]!, "A"),
        mark(pts[pts.length - 1]!, "B"),
      ]).addTo(map);
      const i = insetRef.current;
      map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [24 + i.left, 80], paddingBottomRight: [24, 24 + i.bottom], maxZoom: 9 });
    };
    return () => {
      clear();
      mapBus.showRoute = () => {};
    };
  }, []);

  // VBuddy Ground: the airport chart and the taxi route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !el.current) return;
    return attachGround(
      map,
      el.current,
      () => {
        const i = insetRef.current;
        return { tl: [24 + i.left, 80], br: [24, 24 + i.bottom] };
      },
      () => onFollowRef.current(false),
    );
  }, []);

  useEffect(() => {
    mapBus.focus = (cs) => {
      const m = trafficMarks.current.get(cs)?.m;
      const map = mapRef.current;
      if (!m || !map) return;
      onFollowRef.current(false);
      const z = Math.max(map.getZoom(), 8);
      map.setView(centreFor(map, m.getLatLng(), z), z);
      m.openPopup();
    };
    return () => {
      mapBus.focus = () => {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" role="application" aria-label="Moving map with your aircraft, network traffic and online ATC" />;
}
