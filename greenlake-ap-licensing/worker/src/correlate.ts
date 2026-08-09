// Join GreenLake device/subscription data with Aruba Central AP status.
// Pure data transformation — faithful port of glc/correlate.py.
// Field access stays defensive: HPE ships several casings/shapes for these
// payloads, so every lookup tries the known variants before giving up.

const AP_DEVICE_TYPES = ["AP", "IAP", "ACCESS POINT", "ACCESS_POINT"];

function first(record: any, ...keys: string[]): any {
  if (record && typeof record === "object") {
    for (const key of keys) {
      const v = record[key];
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return null;
}

function firstOr(record: any, keys: string[], fallback: any): any {
  const v = first(record, ...keys);
  return v === null ? fallback : v;
}

export function normMac(mac: any): string {
  if (!mac) return "";
  return String(mac).toLowerCase().replace(/[^0-9a-f]/g, "");
}

export function normSerial(serial: any): string {
  return serial ? String(serial).trim().toUpperCase() : "";
}

function parseDate(value: any): Date | null {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const isNumeric =
    typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value));
  if (isNumeric) {
    let num = Number(value);
    if (num > 1e12) num /= 1000; // milliseconds → seconds
    if (num <= 0) return null;
    return new Date(num * 1000);
  }
  if (typeof value === "string") {
    const d = new Date(value); // ISO 8601 (incl. trailing Z) and YYYY-MM-DD
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// Normalize a resource's GreenLake tags into sorted 'key: value' strings.
// GreenLake tags are user-assigned key/value pairs on devices and
// subscriptions alike (the same ones shown as 'tag:<Name>' columns in
// GreenLake's own CSV exports). HPE has shipped them both as a
// {name: value} map and as a list of {"key"/"name": ..., "value": ...}
// objects, so both are supported.
function parseTags(raw: any): string[] {
  const rawTags = firstOr(raw, ["tags"], {});
  const pairs: [string, any][] = [];
  if (rawTags && typeof rawTags === "object" && !Array.isArray(rawTags)) {
    for (const key of Object.keys(rawTags)) pairs.push([key, rawTags[key]]);
  } else if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      if (t && typeof t === "object") {
        const key = first(t, "key", "name");
        if (key) pairs.push([String(key), first(t, "value")]);
      } else if (typeof t === "string") {
        pairs.push([t, ""]);
      }
    }
  }
  return pairs
    .map(([k, v]) => (v !== null && v !== undefined && v !== "" ? `${k}: ${v}` : k))
    .sort();
}

function toInt(value: any): number | null {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

// -- extraction ------------------------------------------------------------

interface GlDevice {
  gl_id: string;
  serial: string;
  mac: string;
  mac_display: string;
  device_type: string;
  model: string;
  subscription_keys: string[];
  tags: string[];
}

function parseGlDevice(raw: any): GlDevice {
  const subs = firstOr(raw, ["subscription", "subscriptions"], []) || [];
  const keys: string[] = [];
  for (const sub of Array.isArray(subs) ? subs : []) {
    if (sub && typeof sub === "object") {
      const key = first(sub, "key", "subscriptionKey", "subscription_key");
      if (key) keys.push(String(key));
    } else if (typeof sub === "string") {
      keys.push(sub);
    }
  }
  return {
    gl_id: firstOr(raw, ["id", "deviceId", "device_id"], ""),
    serial: normSerial(first(raw, "serialNumber", "serial_number", "serial")),
    mac: normMac(first(raw, "macAddress", "mac_address", "mac")),
    mac_display: firstOr(raw, ["macAddress", "mac_address", "mac"], ""),
    device_type: String(firstOr(raw, ["deviceType", "device_type", "type"], "")).toUpperCase(),
    model: firstOr(raw, ["model", "partNumber", "part_number"], ""),
    subscription_keys: keys,
    tags: parseTags(raw),
  };
}

interface GlSub {
  key: string;
  tier: string;
  sku: string;
  quantity: number | null;
  available: number | null;
  start: string | null;
  end: string | null;
  end_dt: Date | null;
  tags: string[];
}

function parseGlSubscription(raw: any): GlSub {
  const appts = firstOr(raw, ["appointments"], {}) || {};
  const start = parseDate(
    first(appts, "subscriptionStart", "subscription_start", "startAt") ||
      first(raw, "subscriptionStart", "subscription_start", "startDate", "start"),
  );
  const end = parseDate(
    first(appts, "subscriptionEnd", "subscription_end", "endAt") ||
      first(raw, "subscriptionEnd", "subscription_end", "endDate", "end"),
  );
  return {
    key: String(firstOr(raw, ["key", "subscriptionKey", "subscription_key"], "")),
    tier: firstOr(
      raw,
      ["subscriptionTier", "subscription_tier", "tier", "subscriptionType", "subscription_type"],
      "",
    ),
    sku: firstOr(raw, ["sku", "productSku"], ""),
    quantity: toInt(first(raw, "quantity", "qty")),
    available: toInt(first(raw, "availableQuantity", "available_quantity")),
    start: isoDate(start),
    end: isoDate(end),
    end_dt: end,
    tags: parseTags(raw),
  };
}

function normStatus(value: any): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (["up", "online", "connected"].includes(text)) return "Up";
  if (["down", "offline", "disconnected"].includes(text)) return "Down";
  if (!value) return "Unknown";
  const s = String(value);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

interface CentralAp {
  serial: string;
  mac: string;
  name: string;
  status: string;
  site: string;
  group: string;
  model: string;
  ip: string;
  last_modified: Date | null;
  firmware: string;
}

function parseCentralAp(raw: any): CentralAp {
  return {
    serial: normSerial(first(raw, "serial", "serial_number", "serialNumber")),
    mac: normMac(first(raw, "macaddr", "mac_address", "mac", "macAddress")),
    name: firstOr(raw, ["name", "deviceName", "device_name", "hostname"], ""),
    status: normStatus(first(raw, "status")),
    site: firstOr(raw, ["site", "siteName", "site_name"], "") || "",
    group: firstOr(raw, ["group_name", "group", "scopeName"], "") || "",
    model: firstOr(raw, ["model"], ""),
    ip: firstOr(raw, ["ip_address", "ip", "ipAddress"], ""),
    last_modified: parseDate(first(raw, "last_modified", "lastSeenAt", "lastModifiedAt")),
    firmware: firstOr(raw, ["firmware_version", "firmwareVersion"], ""),
  };
}

function isAp(dev: GlDevice): boolean {
  const dtype = dev.device_type;
  return AP_DEVICE_TYPES.some((t) => dtype.includes(t)) || dtype === "";
}

// Evaluation subscriptions aren't flagged by a dedicated API field; HPE
// encodes it in the tier/SKU text (e.g. "FOUNDATION_EVAL").
function isEvalSub(sub: GlSub): boolean {
  return `${sub.tier} ${sub.sku}`.toLowerCase().includes("eval");
}

// -- correlation -----------------------------------------------------------

export interface CorrelateOpts {
  now?: Date;
  expiringDays?: number;
  includeNonAp?: boolean;
  centralSource?: string;
  ignoredSerials?: string[];
}

export function correlate(
  glDevicesRaw: any[],
  glSubsRaw: any[],
  centralApsRaw: any[],
  opts: CorrelateOpts = {},
): any {
  const now = opts.now ?? new Date();
  const expiringDays = opts.expiringDays ?? 90;
  const includeNonAp = opts.includeNonAp ?? false;
  const centralSource = opts.centralSource ?? "Aruba Central";
  const ignored = new Set(
    (opts.ignoredSerials ?? []).filter(Boolean).map((s) => normSerial(s)),
  );

  let devices = glDevicesRaw.map(parseGlDevice);
  if (!includeNonAp) devices = devices.filter(isAp);

  const subs = new Map<string, GlSub>();
  for (const s of glSubsRaw.map(parseGlSubscription)) {
    if (s.key) subs.set(s.key, s);
  }

  const central = centralApsRaw.map(parseCentralAp);
  const bySerial = new Map<string, CentralAp>();
  const byMac = new Map<string, CentralAp>();
  for (const a of central) {
    if (a.serial) bySerial.set(a.serial, a);
    if (a.mac) byMac.set(a.mac, a);
  }

  function subState(keys: string[]): {
    state: string;
    tiers: string[];
    soonest: Date | null;
  } {
    if (!keys.length) return { state: "Unlicensed", tiers: [], soonest: null };
    const tiers: string[] = [];
    const ends: Date[] = [];
    let state = "Licensed";
    for (const key of keys) {
      const sub = subs.get(key);
      if (sub) {
        if (sub.tier) tiers.push(sub.tier);
        if (sub.end_dt) ends.push(sub.end_dt);
      }
    }
    const soonest = ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null;
    if (soonest && soonest < now) state = "Expired";
    return { state, tiers, soonest };
  }

  const rows: any[] = [];
  for (const dev of devices) {
    const ap = bySerial.get(dev.serial) || byMac.get(dev.mac) || null;
    const { state, tiers, soonest } = subState(dev.subscription_keys);
    rows.push({
      name: ap ? ap.name : "",
      gl_id: dev.gl_id,
      ignored: ignored.has(dev.serial),
      serial: dev.serial,
      mac: dev.mac_display,
      model: ap && ap.model ? ap.model : dev.model,
      site: ap ? ap.site : "",
      group: ap ? ap.group : "",
      status: ap ? ap.status : "Not in Central",
      in_central: Boolean(ap),
      device_type: dev.device_type || "AP",
      license_state: state,
      keys: dev.subscription_keys,
      tiers: [...new Set(tiers)].sort(),
      sub_end: isoDate(soonest),
      last_seen: ap ? isoDate(ap.last_modified) : null,
      ip: ap ? ap.ip : "",
      tags: dev.tags,
    });
  }

  const downAndLicensed = rows.filter(
    (r) => r.status === "Down" && r.license_state !== "Unlicensed",
  );
  const downLicensed = downAndLicensed.filter((r) => !r.ignored);
  const ignoredDown = downAndLicensed.filter((r) => r.ignored);
  const unlicensed = rows.filter((r) => r.license_state === "Unlicensed");
  const expired = rows.filter((r) => r.license_state === "Expired");
  const notInCentral = rows.filter((r) => !r.in_central);

  // subscription summary with AP-name mapping
  const keyToAps = new Map<string, string[]>();
  const keyToDeviceTypes = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const key of row.keys) {
      if (!keyToAps.has(key)) keyToAps.set(key, []);
      keyToAps.get(key)!.push(row.name || row.serial || row.mac);
      if (!keyToDeviceTypes.has(key)) keyToDeviceTypes.set(key, new Set());
      keyToDeviceTypes.get(key)!.add(row.device_type);
    }
  }
  const subRows: any[] = [];
  for (const key of [...subs.keys()].sort()) {
    const sub = subs.get(key)!;
    const endDt = sub.end_dt;
    const daysLeft = endDt
      ? Math.floor((endDt.getTime() - now.getTime()) / 86400000)
      : null;
    const attached = (keyToAps.get(key) ?? []).slice().sort();
    const used =
      sub.quantity !== null && sub.available !== null
        ? sub.quantity - sub.available
        : attached.length || null;
    subRows.push({
      key,
      sub_type: isEvalSub(sub) ? "Eval" : "Paid",
      tier: sub.tier,
      sku: sub.sku,
      device_types: [...(keyToDeviceTypes.get(key) ?? new Set<string>())].sort(),
      quantity: sub.quantity,
      available: sub.available,
      used,
      start: sub.start,
      end: sub.end,
      days_left: daysLeft,
      expired: Boolean(endDt && endDt < now),
      aps: attached,
      tags: sub.tags,
    });
  }
  const expiringSoon = subRows.filter(
    (s) => s.days_left !== null && s.days_left >= 0 && s.days_left <= expiringDays,
  );

  const up = rows.filter((r) => r.status === "Up").length;
  const down = rows.filter((r) => r.status === "Down").length;

  const pad = (n: number) => String(n).padStart(2, "0");
  const generated =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;

  return {
    generated,
    central_source: centralSource,
    expiring_days: expiringDays,
    summary: {
      total_aps: rows.length,
      up,
      down,
      not_in_central: notInCentral.length,
      licensed: rows.filter((r) => r.license_state === "Licensed").length,
      unlicensed: unlicensed.length,
      expired: expired.length,
      down_licensed: downLicensed.length,
      ignored_down: ignoredDown.length,
      subscriptions: subRows.length,
      expiring_soon: expiringSoon.length,
    },
    aps: rows,
    down_licensed: downLicensed,
    ignored_down: ignoredDown,
    unlicensed,
    subscriptions: subRows,
    not_in_central: notInCentral,
  };
}
