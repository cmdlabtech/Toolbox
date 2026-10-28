// Large campus sample for hub-and-spoke spacing. Loaded in the browser with
// ?sample=large and by the layout tests. The small fixture stays the default.
// Names, serials, and addresses are synthetic. 44 switches, 6 buildings.

const BUILDINGS = [
  { site: "Building A", code: "BLDG-A", access: 6, core: "CORE-01" },
  { site: "Building B", code: "BLDG-B", access: 9 },
  { site: "Building C", code: "BLDG-C", access: 7 },
  { site: "Building D", code: "BLDG-D", access: 6 },
  { site: "Building E", code: "BLDG-E", access: 5 },
  { site: "Building F", code: "BLDG-F", access: 5 },
];

function serial(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return `SG${(h >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 8)}`;
}

function mac(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `38:21:c7:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`;
}

function sw(name, site, model, ip, status = "ONLINE", group = null) {
  const trimmed = typeof group === "string" ? group.trim() : "";
  return {
    serial: serial(name),
    mac: mac(name),
    name,
    model,
    status,
    site,
    siteId: site,
    group: trimmed || null,
    ipv4: ip,
    vlans: [{ id: "99", name: "Management", ipv4: ip }],
    interfaces: [],
  };
}

function groupName(bi, role, accessIndex, accessCount) {
  if (role === "access" && bi === BUILDINGS.length - 1 && accessIndex === accessCount) return "";
  return `Group ${(bi % 3) + 1}`;
}

/** API-shaped topology, plus coreSerial for the district-core override. */
export function largeSample() {
  const switches = [];
  const externals = [];
  const links = [];
  const coreName = BUILDINGS[0].core;
  const names = [];

  BUILDINGS.forEach((b, bi) => {
    const core = b.core ?? `${b.code}-CORE-01`;
    names.push({ name: core, site: b.site, role: "core" });
    switches.push(sw(core, b.site, bi === 0 ? "Aruba 8360-32Y4C" : "Aruba 6300M 48G", `10.10.${bi}.1`, "ONLINE", groupName(bi, "core", 0, b.access)));
    for (let a = 1; a <= b.access; a++) {
      const name = `${b.code}-SW-${String(a).padStart(2, "0")}`;
      names.push({ name, site: b.site, role: "access", bi, a });
      switches.push(sw(
        name,
        b.site,
        a % 2 ? "Aruba 6100 48G 4SFP+" : "Aruba 6200F 48G",
        `10.10.${bi}.${10 + a}`,
        a === b.access && bi === 2 ? "OFFLINE" : "ONLINE",
        groupName(bi, "access", a, b.access),
      ));
    }
  });

  const byName = new Map(switches.map((s) => [s.name, s]));
  const link = (a, ap, b, bp, source = "topology") => {
    links.push({
      from: byName.get(a)?.serial ?? a,
      to: byName.get(b)?.serial ?? b,
      fromPort: ap,
      toPort: bp,
      source,
    });
  };

  // Dense inside each building: every switch to every other switch there.
  for (const b of BUILDINGS) {
    const members = names.filter((n) => n.site === b.site).map((n) => n.name);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        link(members[i], `1/1/${j}`, members[j], "1/1/49");
      }
    }
  }
  // Building cores back to the district core, plus a few access cross-links
  // so warning badges show up on cards that talk to another building.
  for (const b of BUILDINGS.slice(1)) {
    link(coreName, `1/1/${b.code.length}`, `${b.code}-CORE-01`, "1/1/49");
  }
  const crosses = [
    ["BLDG-B-SW-01", "BLDG-C-CORE-01"],
    ["BLDG-B-SW-04", "BLDG-D-CORE-01"],
    ["BLDG-C-SW-02", "BLDG-E-CORE-01"],
    ["BLDG-D-SW-03", "BLDG-F-CORE-01"],
    ["BLDG-E-SW-01", "BLDG-B-CORE-01"],
    ["BLDG-F-SW-02", "CORE-01"],
    ["BLDG-C-SW-05", "BLDG-B-CORE-01"],
    ["BLDG-D-SW-01", "BLDG-E-CORE-01"],
  ];
  for (const [a, b] of crosses) link(a, "1/1/48", b, "1/1/47");

  // LLDP neighbors. Every access switch has at least one, and every fourth
  // access switch is crowded so ghost pills stack in the old layout.
  const ghost = (name, type, local, port) => {
    const id = serial(name);
    externals.push({ serial: id, name, mac: mac(name), type, status: "ONLINE" });
    links.push({
      from: byName.get(local).serial,
      to: id,
      fromPort: port,
      toPort: "eth0",
      source: "neighbours",
    });
  };

  ghost("CORE-FW-01", "Firewall", coreName, "1/1/40");
  ghost("CORE-RTR-01", "Router", coreName, "1/1/41");
  ghost("CORE-WAN-01", "Router", coreName, "1/1/42");

  for (const n of names) {
    const code = BUILDINGS.find((b) => b.site === n.site).code;
    if (n.role === "core" && n.name !== coreName) {
      ghost(`AP-${code}-C1`, "Access Point", n.name, "1/1/30");
      ghost(`PH-${code}-C2`, "Phone", n.name, "1/1/31");
    }
    if (n.role !== "access") continue;
    const count = n.a % 4 === 0 ? 4 : n.a % 2 === 0 ? 2 : 1;
    for (let g = 1; g <= count; g++) {
      const kind = g % 3 === 0 ? "CAM" : g % 3 === 1 ? "AP" : "PH";
      const type = kind === "CAM" ? "Camera" : kind === "AP" ? "Access Point" : "Phone";
      ghost(`${kind}-${code}-${String(n.a).padStart(2, "0")}-${g}`, type, n.name, `1/1/${20 + g}`);
    }
  }

  return {
    mock: true,
    generatedAt: "2026-03-18T15:04:00.000Z",
    sites: BUILDINGS.map((b) => ({ id: b.site, name: b.site })),
    switches,
    externals,
    links,
    warnings: [],
    coreSerial: serial(coreName),
  };
}

// Wider campus: 44 switches, 8 buildings, about 650 links, and a crowd of
// LLDP neighbors. Names are generic. The district core is the highest-degree
// switch, so the model infers it.
const CAMPUS = [
  { site: "Building A", code: "BLDG-A", access: 5, core: "CORE-01" },
  { site: "Building B", code: "BLDG-B", access: 6 },
  { site: "Building C", code: "BLDG-C", access: 6 },
  { site: "Building D", code: "BLDG-D", access: 5 },
  { site: "Building E", code: "BLDG-E", access: 4 },
  { site: "Building F", code: "BLDG-F", access: 4 },
  { site: "Building G", code: "BLDG-G", access: 3 },
  { site: "Building H", code: "BLDG-H", access: 3 },
];

export function campusSample() {
  const switches = [];
  const externals = [];
  const links = [];
  const coreName = CAMPUS[0].core;
  const names = [];

  CAMPUS.forEach((b, bi) => {
    const core = b.core ?? `${b.code}-CORE-01`;
    names.push({ name: core, site: b.site, role: "core" });
    switches.push(sw(core, b.site, bi === 0 ? "Aruba 8360-32Y4C" : "Aruba 6300M 48G", `10.20.${bi}.1`));
    for (let a = 1; a <= b.access; a++) {
      const name = `${b.code}-SW-${String(a).padStart(2, "0")}`;
      names.push({ name, site: b.site, role: "access", bi, a });
      switches.push(sw(
        name,
        b.site,
        a % 2 ? "Aruba 6100 48G 4SFP+" : "Aruba 6200F 48G",
        `10.20.${bi}.${10 + a}`,
        a === b.access && bi === 3 ? "OFFLINE" : "ONLINE",
      ));
    }
  });

  const byName = new Map(switches.map((s) => [s.name, s]));
  const link = (a, ap, b, bp, source = "topology") => {
    links.push({
      from: byName.get(a)?.serial ?? a,
      to: byName.get(b)?.serial ?? b,
      fromPort: ap,
      toPort: bp,
      source,
    });
  };
  const ghost = (name, type, local, port) => {
    const id = serial(name);
    externals.push({ serial: id, name, mac: mac(name), type, status: "ONLINE" });
    links.push({
      from: byName.get(local).serial,
      to: id,
      fromPort: port,
      toPort: "eth0",
      source: "neighbours",
    });
  };

  for (const b of CAMPUS) {
    const members = names.filter((n) => n.site === b.site).map((n) => n.name);
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const source = j === i + 1 && i % 3 === 0 ? "neighbours" : "topology";
        link(members[i], `1/1/${j}`, members[j], "1/1/49", source);
      }
    }
  }
  for (const b of CAMPUS.slice(1)) {
    link(coreName, `1/1/${b.code.length}`, `${b.code}-CORE-01`, "1/1/49", "neighbours");
  }
  const crosses = [
    ["BLDG-B-SW-01", "BLDG-C-CORE-01"],
    ["BLDG-C-SW-02", "BLDG-D-CORE-01"],
    ["BLDG-D-SW-01", "BLDG-E-CORE-01"],
    ["BLDG-E-SW-01", "BLDG-F-CORE-01"],
    ["BLDG-F-SW-02", "BLDG-G-CORE-01"],
    ["BLDG-G-SW-01", "BLDG-H-CORE-01"],
    ["BLDG-H-SW-01", "CORE-01"],
    ["BLDG-B-SW-03", "BLDG-A-SW-01"],
  ];
  for (const [a, b] of crosses) link(a, "1/1/48", b, "1/1/47");

  ghost("CORE-FW-01", "Firewall", coreName, "1/1/40");
  ghost("CORE-RTR-01", "Router", coreName, "1/1/41");
  for (const b of CAMPUS.slice(1)) {
    ghost(`AP-${b.code}-C1`, "Access Point", `${b.code}-CORE-01`, "1/1/30");
  }
  for (const n of names) {
    if (n.role !== "access") continue;
    const code = CAMPUS.find((b) => b.site === n.site).code;
    const count = 12 + (n.a % 6);
    for (let g = 1; g <= count; g++) {
      const kind = g % 3 === 0 ? "CAM" : g % 3 === 1 ? "AP" : "PH";
      const type = kind === "CAM" ? "Camera" : kind === "AP" ? "Access Point" : "Phone";
      ghost(`${kind}-${code}-${String(n.a).padStart(2, "0")}-${g}`, type, n.name, `1/1/${20 + (g % 20)}`);
    }
  }

  return {
    mock: true,
    generatedAt: "2026-03-18T15:04:00.000Z",
    sites: CAMPUS.map((b) => ({ id: b.site, name: b.site })),
    switches,
    externals,
    links,
    warnings: [],
  };
}
