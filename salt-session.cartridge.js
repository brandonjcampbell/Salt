/* =========================================================================
 * salt-session.cartridge.js  —  the Session Ontology scope readout
 * =========================================================================
 * A pepper cartridge for the card-game ontology built over one session.
 *
 * The ontology itself lives as a scraped bundle in bundles/bundle-session-
 * ontology.json (auto-loaded into the Imports tab). This cartridge does NOT
 * embed a copy of it — it declares `requiredBundle` and lets pepper's
 * ensureBundle import the scraped bundle on mount. Loading this file via the
 * pepper "load URL" input registers the cartridge and auto-mounts it; mounting
 * imports the ontology (if not already present) and renders the derived-scope
 * table below.
 *
 * The ontology is triples only — no patterns, no implications — so Fire All is
 * a no-op. A type's full scope is the union of its own SCOPED_TO plus every
 * scope inherited via IS; that derivation is what this readout displays.
 * ========================================================================= */
(function () {
  "use strict";

  if (typeof pepper === "undefined" || typeof pepper.registerCartridge !== "function") return;

  const BUNDLE_ID = "bundle-session-ontology";

  // Union of a type's own SCOPED_TO plus everything inherited via IS.
  function fullScope(pep, name) {
    const seen = new Set();
    const scopes = new Set();
    const walk = (n) => {
      if (seen.has(n)) return;
      seen.add(n);
      for (const t of pep.query(n, "SCOPED_TO", null)) scopes.add(t.target);
      for (const t of pep.query(n, "IS", null)) walk(t.target);
    };
    walk(name);
    return [...scopes];
  }

  pepper.registerCartridge("salt-session", {
    name: "Session Ontology",
    description: "Scope readout for the session ontology bundle.",
    requiredBundle: BUNDLE_ID,
    mount(container, pep) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "font-family:ui-monospace,monospace;font-size:12px;color:#e8e8e8;" +
        "line-height:1.7;padding:4px 2px;max-width:640px";

      const rows = [
        "Zone", "RunZone", "BattleZone", "BanishPile", "Party",
        "Deck", "RunDeck", "BattleDeck", "Hand", "DiscardPile",
        "Backstory", "Inventory",
        "Player", "Agent", "AI", "Runner",
        "Card", "Print", "RunPrint", "BattlePrint",
      ];

      const body = rows.map((n) => {
        const s = fullScope(pep, n);
        const txt = s.length ? s.join(", ") : "—";
        return `<div style="display:grid;grid-template-columns:150px 1fr;gap:8px">
          <span style="color:rgba(255,255,255,.55)">${n}</span>
          <span>{ ${txt} }</span>
        </div>`;
      }).join("");

      const counts = {
        concepts: pep.query(null, "IS", null).length,
        triples: pep.query(null, null, null).length,
      };

      wrap.innerHTML =
        `<div style="color:rgba(255,255,255,.5);margin-bottom:10px">` +
        `session ontology loaded &middot; ${counts.triples} triples ` +
        `(${counts.concepts} IS edges) &middot; no implications &mdash; nothing fires` +
        `</div>` +
        `<div style="color:rgba(255,255,255,.4);font-size:10px;` +
        `text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">` +
        `derived scope &middot; own SCOPED_TO ∪ inherited via IS</div>` +
        body;

      container.appendChild(wrap);
      return () => wrap.remove();
    },
  });
})();
