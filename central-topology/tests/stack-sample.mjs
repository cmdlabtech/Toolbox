// Shared fixture: the large sample with one switch made a 3-member stack.
import { largeSample } from "../site/js/large-sample.js";

const STACKED = "BLDG-B-SW-02";
/** The large sample with one access switch made a 3-member stack. */
export function sampleWithStack() {
  const d = largeSample();
  const head = d.switches.find((s) => s.name === STACKED);
  Object.assign(head, { conductorSerial: head.serial, stackMemberId: 1 });
  ["SGSTACKB02", "SGSTACKC03"].forEach((serial, i) => d.switches.push({ ...head, serial, mac: `38:21:c7:ff:00:0${i}`, stackMemberId: i + 2, stackRole: i ? undefined : "standby" }));
  // Members cabled the way real stacks are: VSF links between members, a
  // second uplink from member 2 to the same building core, and an LLDP row
  // from member 3 to a neighbour the conductor already links to.
  const [m1, m2, m3] = ["head", "SGSTACKB02", "SGSTACKC03"].map((x) => (x === "head" ? head.serial : x));
  const up = d.links.find((l) => l.to === m1 && l.toPort === "1/1/49");
  d.links.push(
    { from: m1, to: m2, fromPort: "1/1/51", toPort: "2/1/51", source: "topology", isSibling: true },
    { from: m2, to: m3, fromPort: "2/1/52", toPort: "3/1/52", source: "topology", isSibling: true },
    { from: m3, to: m1, fromPort: "3/1/51", toPort: "1/1/52", source: "neighbours" },
    { from: up.from, to: m2, fromPort: "1/1/40", toPort: "2/1/49", source: "topology" },
    { from: m3, to: "SG865FB3A0", fromPort: "3/1/3", toPort: "1/1/50", source: "neighbours" },
  );
  return d;
}
