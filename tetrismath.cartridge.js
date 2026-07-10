// =============================================================================
//  tetris-math.cartridge.js — single-cell Tetris on math-native salt.
// =============================================================================
//
// This cartridge demonstrates the math-native salt substrate (Stages 1–3 of
// the value-typed-triples / arithmetic-constraints / parametric-rule-expansion
// extensions). The embedded bundle is structurally tiny compared to the
// original tile-instance approach:
//
//   * No 375 Cell_R_C concepts.
//   * No 360 SOUTH-OF / 350 EAST-OF topology triples.
//   * Position carries HAS_ROW:Int and HAS_COL:Int as value-typed triples.
//   * Gravity is an arithmetic rule: new_row = r + 1.
//   * Row-full detection is one parametric rule template expanded across
//     25 rows at bundle-load.
//
// The cartridge itself is minimal: a tick driver, a spawn input, and a
// render projection from graph rows (skipping Cleared rows) to fixed UI
// rows. All game-state logic — falling, landing, locking, row-clear
// tagging — lives in salt.
// =============================================================================

(function () {
  if (typeof pepper === "undefined" || typeof pepper.registerCartridge !== "function") return;

  const ROWS = 25;
  const COLS = 15;

  // ---------------------------------------------------------------------------
  //  Embedded bundle: bundle-tetris-math
  // ---------------------------------------------------------------------------
  const bundle = {
    id: "bundle-tetris-math",
    name: "Tetris (math-native)",
    category: "Bundles",
    description:
      "Single-cell Tetris on a 15×25 board, built on math-native salt. " +
      "Positions carry HAS_ROW:Int and HAS_COL:Int as value-typed triples. " +
      "Gravity is arithmetic: minted Position has HAS_ROW = r+1. Row-full " +
      "detection is one parametric template expanded across 25 rows at " +
      "bundle-load — each instance verifies 15 specific HAS_COL values by " +
      "index lookup, never enumerates distinct cell variables. Drops the " +
      "375 Cell + 700+ SOUTH/EAST topology triples from the original tile " +
      "Tetris; the bundle is now schema + 4 base rules + 25 parametric.",
    dependsOn: [],
    concepts: [
      // Core game types.
      { name: "Block",        types: ["Concept"] },
      { name: "Position",     types: ["Concept"] },
      // Tag concepts — applied via IS to mark lifecycle state.
      { name: "Falling",      types: ["Concept"] },
      { name: "Locked",       types: ["Concept"] },
      { name: "SouthBlocked", types: ["Concept"] },
      { name: "Cleared",      types: ["Concept"] },
      { name: "Processed",    types: ["Concept"] },
      { name: "Shaped",       types: ["Concept"] },
      // Tetromino shape concepts. A block is tagged with exactly one shape
      // on spawn (cartridge picks at random); the matching shape rule then
      // mints the remaining 3 cells at offsets relative to the spawn cell.
      // Each shape rule is one-shot per block — guarded by NOT IS Shaped,
      // tagged IS Shaped on completion.
      { name: "I_Shape", types: ["Concept"] },
      { name: "O_Shape", types: ["Concept"] },
      { name: "L_Shape", types: ["Concept"] },
      { name: "T_Shape", types: ["Concept"] },
      // The Tick concept — cartridge mints a fresh Tick_N each game tick.
      // A StepDown rule consumes one unprocessed Tick per pass; once tagged
      // Processed, that Tick no longer drives further falling.
      { name: "Tick",         types: ["Concept"] },
      // Move events — fresh concept per key press. Salt rules check whether
      // the move is blocked (by edge or by locked-cell collision), and if
      // not, mint new Positions at the shifted column for every current
      // cell of the falling block. Cartridge prunes the move concept
      // after firing so subsequent presses get a clean slate.
      { name: "MoveLeft",     types: ["Concept"] },
      { name: "MoveRight",    types: ["Concept"] },
      { name: "Blocked",      types: ["Concept"] },
      // Row identity concepts: Row_0 through Row_24, pre-allocated so the
      // parametric RowFull rule's GEN body (`Row_{R} IS Cleared`) can
      // address an existing concept rather than minting per-row.
      ...Array.from({ length: ROWS }, (_, r) => ({ name: `Row_${r}`, types: ["Concept"] })),
    ],
    contexts: [
      // Position carries two value-typed triples — HAS_ROW and HAS_COL,
      // both with Int targets. The target_type "Concept" here is just a
      // schema declaration; actual targets are numbers (the matcher's Int
      // primitive type handles them).
      { name: "HAS_ROW", subject_type: "Position", target_type: "Concept" },
      { name: "HAS_COL", subject_type: "Position", target_type: "Concept" },
      // FOR — which Block this Position belongs to. Constant across the
      // Position chain (UPDATES preserves FOR).
      { name: "FOR",     subject_type: "Position", target_type: "Block" },
      // UPDATES — the supersession chain. A Position with no incoming
      // UPDATES is "current"; the matcher's NOT-newer-UPDATES check is the
      // canonical "find current position" idiom.
      { name: "UPDATES", subject_type: "Position", target_type: "Position" },
    ],
    implications: [
      // ---------------------------------------------------------------------
      // Shape rules: I/O/L/T. One per shape. Each fires once per block
      // (guarded by NOT IS Shaped → tags IS Shaped on completion) and
      // mints 3 sibling positions at offsets relative to the spawn cell.
      // No UPDATES links between the spawn cell and the extras — they're
      // siblings, all "current," all fall together on every StepDown pass.
      // ---------------------------------------------------------------------
      { name: "ShapeI", of: "ShapeI_Of_Pat", generates: "ShapeI_Gen_Pat" },
      { name: "ShapeO", of: "ShapeO_Of_Pat", generates: "ShapeO_Gen_Pat" },
      { name: "ShapeL", of: "ShapeL_Of_Pat", generates: "ShapeL_Gen_Pat" },
      { name: "ShapeT", of: "ShapeT_Of_Pat", generates: "ShapeT_Gen_Pat" },
      // ---------------------------------------------------------------------
      // Lateral movement. Each press of ←/→ in the cartridge mints a fresh
      // MoveLeft / MoveRight concept. The rules below check whether the
      // move is blocked (by the playfield edge or by a locked cell in the
      // destination column at the same row), and only if not blocked,
      // mint shifted-column successors for every current cell of the
      // falling block. The move concept is tagged Processed at the end of
      // the do-rule; the cartridge prunes it afterward.
      //
      // Three rules per direction. Declaration order matters — the matcher
      // fires rules in order within a pass, so the two block-detectors run
      // first and the do-rule sees their `m IS Blocked` tag.
      // ---------------------------------------------------------------------
      { name: "MoveLeftBlockedEdge",   of: "MLBE_Of",  generates: "MLBE_Gen"  },
      { name: "MoveLeftBlockedLocked", of: "MLBL_Of",  generates: "MLBL_Gen"  },
      { name: "MoveLeftDo",            of: "MLDo_Of",  generates: "MLDo_Gen"  },
      { name: "MoveRightBlockedEdge",   of: "MRBE_Of", generates: "MRBE_Gen" },
      { name: "MoveRightBlockedLocked", of: "MRBL_Of", generates: "MRBL_Gen" },
      { name: "MoveRightDo",            of: "MRDo_Of", generates: "MRDo_Gen" },
      // ---------------------------------------------------------------------
      // SouthBlocked: a falling block is south-blocked iff any of its
      // current cells has a LOCKED-block cell directly below in the same
      // column. Tag fires per matching block-cell pair, and persists once
      // asserted (salt is additive). Acts as the conjunctive precondition
      // for "this block lands instead of stepping" — a single-clause NOT
      // SouthBlocked check downstream is equivalent to a multi-clause
      // negation of the original conjunction.
      // ---------------------------------------------------------------------
      {
        name: "SouthBlocked",
        of: "SouthBlocked_Of_Pat",
        generates: "SouthBlocked_Gen_Pat",
      },
      // ---------------------------------------------------------------------
      // StepDown: each unprocessed Tick mints, for every current cell of
      // every Falling-but-not-SouthBlocked-and-not-Locked block, a new
      // Position at row+1 / same col / UPDATES the previous. The Tick is
      // tagged Processed in GEN so a future fire pass can't re-consume it.
      // ---------------------------------------------------------------------
      {
        name: "StepDown",
        of: "StepDown_Of_Pat",
        generates: "StepDown_Gen_Pat",
      },
      // ---------------------------------------------------------------------
      // LandOnFloor: any current cell of a Falling block at HAS_ROW = 24
      // (the floor) immediately locks the block. Per-cell trigger but the
      // tag is on the block, so multi-cell semantics work for free.
      // ---------------------------------------------------------------------
      {
        name: "LandOnFloor",
        of: "LandOnFloor_Of_Pat",
        generates: "LandOnFloor_Gen_Pat",
      },
      // ---------------------------------------------------------------------
      // LandOnBlock: any Falling block currently tagged SouthBlocked is
      // also tagged Locked. The two-rule split (SouthBlocked + LandOnBlock)
      // keeps the rule bodies single-conjunction-friendly.
      // ---------------------------------------------------------------------
      {
        name: "LandOnBlock",
        of: "LandOnBlock_Of_Pat",
        generates: "LandOnBlock_Gen_Pat",
      },
      // ---------------------------------------------------------------------
      // RowFull (parametric): for each row R ∈ [0, 25), if 15 current
      // positions exist with HAS_ROW = R and HAS_COL = 0..14, tag Row_R
      // as Cleared. One template, 25 expanded rules at bundle-load. Each
      // expanded rule has 45 OF clauses (15 row + 15 col + 15 NOT-newer).
      // Each rule fires at most once per board state (the Cleared tag is
      // monotonic — once on, always on; salt's dedup prevents re-firing).
      // ---------------------------------------------------------------------
      {
        name: "RowFull",
        params: [{ name: "R", over: [0, ROWS] }],
        of: buildRowFullOfBody(),
        generates: [["Row_{R}", "IS", "Cleared"]],
      },
    ],
    // The OF/GEN bodies for the named (non-parametric) implications above
    // need to live in the `patterns` array — that's how the existing
    // implication form (of: "PatternName", generates: "PatternName") looks
    // them up at import time. Parametric implications carry their bodies
    // inline (above) so they don't go here.
    patterns: [
      {
        name: "SouthBlocked_Of_Pat",
        body: [
          ["b:Block",     "IS",      "Falling"],
          ["p:Position",  "FOR",     "b:Block"],
          ["p:Position",  "HAS_ROW", "r:Int"],
          ["p:Position",  "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",     "UPDATES", "p:Position"],
          ["other:Position", "HAS_ROW", ["+", "r", 1]],
          ["other:Position", "HAS_COL", "c:Int"],
          ["other:Position", "FOR",     "ob:Block"],
          ["ob:Block",       "IS",      "Locked"],
          ["NOT", "newerOther:Position", "UPDATES", "other:Position"],
        ],
      },
      {
        name: "SouthBlocked_Gen_Pat",
        body: [
          ["b:Block", "IS", "SouthBlocked"],
        ],
      },
      {
        name: "StepDown_Of_Pat",
        body: [
          ["t:Tick",      "IS",      "Tick"],
          ["NOT", "t:Tick",          "IS", "Processed"],
          ["b:Block",     "IS",      "Falling"],
          ["b:Block",     "IS",      "Shaped"],
          ["NOT", "b:Block",         "IS", "SouthBlocked"],
          ["NOT", "b:Block",         "IS", "Locked"],
          ["p:Position",  "FOR",     "b:Block"],
          ["p:Position",  "HAS_ROW", "r:Int"],
          ["p:Position",  "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",  "UPDATES", "p:Position"],
        ],
      },
      {
        name: "StepDown_Gen_Pat",
        body: [
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", ["+", "r", 1]],
          ["p2:Position", "HAS_COL", "c:Int"],
          ["p2:Position", "UPDATES", "p:Position"],
          ["t:Tick",      "IS",      "Processed"],
        ],
      },
      {
        name: "LandOnFloor_Of_Pat",
        body: [
          ["b:Block",    "IS",      "Falling"],
          ["p:Position", "FOR",     "b:Block"],
          ["p:Position", "HAS_ROW", ROWS - 1],
          ["NOT", "newer:Position", "UPDATES", "p:Position"],
        ],
      },
      {
        name: "LandOnFloor_Gen_Pat",
        body: [
          ["b:Block", "IS", "Locked"],
        ],
      },
      {
        name: "LandOnBlock_Of_Pat",
        body: [
          ["b:Block", "IS", "Falling"],
          ["b:Block", "IS", "SouthBlocked"],
        ],
      },
      {
        name: "LandOnBlock_Gen_Pat",
        body: [
          ["b:Block", "IS", "Locked"],
        ],
      },
      // -----------------------------------------------------------------------
      // Shape pattern bodies. Each shape's OF binds the spawn cell at (r, c)
      // and gates on `NOT b IS Shaped`. The GEN mints the remaining 3 cells
      // at offsets specific to that tetromino, then tags `b IS Shaped` to
      // ensure the rule never re-fires.
      //
      //   I_Shape: X X X X    (horizontal 4-bar)
      //   O_Shape: X X        (2×2 square)
      //            X X
      //   L_Shape: X . .      (L-shape, anchor top-left)
      //            X X X
      //   T_Shape: X X X      (T-shape, anchor top-left)
      //            . X .
      //
      // Spawn cell sits at the top-left of every shape's bounding box. The
      // cartridge's spawn-col clamp keeps the box inside the playfield.
      // -----------------------------------------------------------------------
      {
        name: "ShapeI_Of_Pat",
        body: [
          ["b:Block",      "IS",      "I_Shape"],
          ["NOT", "b:Block",          "IS", "Shaped"],
          ["p:Position",   "FOR",     "b:Block"],
          ["p:Position",   "HAS_ROW", "r:Int"],
          ["p:Position",   "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",   "UPDATES", "p:Position"],
        ],
      },
      {
        name: "ShapeI_Gen_Pat",
        body: [
          ["MINT", "p1:Position"],
          ["p1:Position", "FOR",     "b:Block"],
          ["p1:Position", "HAS_ROW", "r:Int"],
          ["p1:Position", "HAS_COL", ["+", "c", 1]],
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", "r:Int"],
          ["p2:Position", "HAS_COL", ["+", "c", 2]],
          ["MINT", "p3:Position"],
          ["p3:Position", "FOR",     "b:Block"],
          ["p3:Position", "HAS_ROW", "r:Int"],
          ["p3:Position", "HAS_COL", ["+", "c", 3]],
          ["b:Block", "IS", "Shaped"],
        ],
      },
      {
        name: "ShapeO_Of_Pat",
        body: [
          ["b:Block",      "IS",      "O_Shape"],
          ["NOT", "b:Block",          "IS", "Shaped"],
          ["p:Position",   "FOR",     "b:Block"],
          ["p:Position",   "HAS_ROW", "r:Int"],
          ["p:Position",   "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",   "UPDATES", "p:Position"],
        ],
      },
      {
        name: "ShapeO_Gen_Pat",
        body: [
          ["MINT", "p1:Position"],
          ["p1:Position", "FOR",     "b:Block"],
          ["p1:Position", "HAS_ROW", "r:Int"],
          ["p1:Position", "HAS_COL", ["+", "c", 1]],
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", ["+", "r", 1]],
          ["p2:Position", "HAS_COL", "c:Int"],
          ["MINT", "p3:Position"],
          ["p3:Position", "FOR",     "b:Block"],
          ["p3:Position", "HAS_ROW", ["+", "r", 1]],
          ["p3:Position", "HAS_COL", ["+", "c", 1]],
          ["b:Block", "IS", "Shaped"],
        ],
      },
      {
        name: "ShapeL_Of_Pat",
        body: [
          ["b:Block",      "IS",      "L_Shape"],
          ["NOT", "b:Block",          "IS", "Shaped"],
          ["p:Position",   "FOR",     "b:Block"],
          ["p:Position",   "HAS_ROW", "r:Int"],
          ["p:Position",   "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",   "UPDATES", "p:Position"],
        ],
      },
      {
        name: "ShapeL_Gen_Pat",
        body: [
          ["MINT", "p1:Position"],
          ["p1:Position", "FOR",     "b:Block"],
          ["p1:Position", "HAS_ROW", ["+", "r", 1]],
          ["p1:Position", "HAS_COL", "c:Int"],
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", ["+", "r", 1]],
          ["p2:Position", "HAS_COL", ["+", "c", 1]],
          ["MINT", "p3:Position"],
          ["p3:Position", "FOR",     "b:Block"],
          ["p3:Position", "HAS_ROW", ["+", "r", 1]],
          ["p3:Position", "HAS_COL", ["+", "c", 2]],
          ["b:Block", "IS", "Shaped"],
        ],
      },
      {
        name: "ShapeT_Of_Pat",
        body: [
          ["b:Block",      "IS",      "T_Shape"],
          ["NOT", "b:Block",          "IS", "Shaped"],
          ["p:Position",   "FOR",     "b:Block"],
          ["p:Position",   "HAS_ROW", "r:Int"],
          ["p:Position",   "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",   "UPDATES", "p:Position"],
        ],
      },
      {
        name: "ShapeT_Gen_Pat",
        body: [
          ["MINT", "p1:Position"],
          ["p1:Position", "FOR",     "b:Block"],
          ["p1:Position", "HAS_ROW", "r:Int"],
          ["p1:Position", "HAS_COL", ["+", "c", 1]],
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", "r:Int"],
          ["p2:Position", "HAS_COL", ["+", "c", 2]],
          ["MINT", "p3:Position"],
          ["p3:Position", "FOR",     "b:Block"],
          ["p3:Position", "HAS_ROW", ["+", "r", 1]],
          ["p3:Position", "HAS_COL", ["+", "c", 1]],
          ["b:Block", "IS", "Shaped"],
        ],
      },
      // -----------------------------------------------------------------------
      // Lateral-move pattern bodies. Pairs: blocked-edge and blocked-locked
      // tag `m IS Blocked` if any cell of the falling block can't shift; the
      // do-rule fires per-cell and mints a same-row, col±1 successor with an
      // UPDATES link, then tags `m IS Processed` so the rule fixpoints.
      // -----------------------------------------------------------------------
      {
        name: "MLBE_Of",
        body: [
          ["m:Concept",     "IS",      "MoveLeft"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_COL", 0],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
        ],
      },
      { name: "MLBE_Gen", body: [["m:Concept", "IS", "Blocked"]] },
      {
        name: "MLBL_Of",
        body: [
          ["m:Concept",     "IS",      "MoveLeft"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_ROW", "r:Int"],
          ["p:Position",    "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
          ["other:Position",      "HAS_ROW", "r:Int"],
          ["other:Position",      "HAS_COL", ["-", "c", 1]],
          ["other:Position",      "FOR",     "ob:Block"],
          ["ob:Block",            "IS",      "Locked"],
          ["NOT", "newerOther:Position", "UPDATES", "other:Position"],
        ],
      },
      { name: "MLBL_Gen", body: [["m:Concept", "IS", "Blocked"]] },
      {
        name: "MLDo_Of",
        body: [
          ["m:Concept",     "IS",      "MoveLeft"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["NOT", "m:Concept",         "IS", "Blocked"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_ROW", "r:Int"],
          ["p:Position",    "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
        ],
      },
      {
        name: "MLDo_Gen",
        body: [
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", "r:Int"],
          ["p2:Position", "HAS_COL", ["-", "c", 1]],
          ["p2:Position", "UPDATES", "p:Position"],
          ["m:Concept", "IS", "Processed"],
        ],
      },
      // ---- right-move (mirror of left) -----
      {
        name: "MRBE_Of",
        body: [
          ["m:Concept",     "IS",      "MoveRight"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_COL", COLS - 1],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
        ],
      },
      { name: "MRBE_Gen", body: [["m:Concept", "IS", "Blocked"]] },
      {
        name: "MRBL_Of",
        body: [
          ["m:Concept",     "IS",      "MoveRight"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_ROW", "r:Int"],
          ["p:Position",    "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
          ["other:Position",      "HAS_ROW", "r:Int"],
          ["other:Position",      "HAS_COL", ["+", "c", 1]],
          ["other:Position",      "FOR",     "ob:Block"],
          ["ob:Block",            "IS",      "Locked"],
          ["NOT", "newerOther:Position", "UPDATES", "other:Position"],
        ],
      },
      { name: "MRBL_Gen", body: [["m:Concept", "IS", "Blocked"]] },
      {
        name: "MRDo_Of",
        body: [
          ["m:Concept",     "IS",      "MoveRight"],
          ["NOT", "m:Concept",         "IS", "Processed"],
          ["NOT", "m:Concept",         "IS", "Blocked"],
          ["b:Block",       "IS",      "Falling"],
          ["NOT", "b:Block",           "IS", "Locked"],
          ["p:Position",    "FOR",     "b:Block"],
          ["p:Position",    "HAS_ROW", "r:Int"],
          ["p:Position",    "HAS_COL", "c:Int"],
          ["NOT", "newer:Position",    "UPDATES", "p:Position"],
        ],
      },
      {
        name: "MRDo_Gen",
        body: [
          ["MINT", "p2:Position"],
          ["p2:Position", "FOR",     "b:Block"],
          ["p2:Position", "HAS_ROW", "r:Int"],
          ["p2:Position", "HAS_COL", ["+", "c", 1]],
          ["p2:Position", "UPDATES", "p:Position"],
          ["m:Concept", "IS", "Processed"],
        ],
      },
    ],
  };

  // ---------------------------------------------------------------------------
  //  Build the RowFull OF body: 15 (HAS_ROW + HAS_COL + NOT-newer-UPDATES)
  //  clause triples, one per column. Generated at module-load (cartridge file
  //  evaluation) — not at bundle-load — so the body is a static array by the
  //  time the parametric expander walks it. The "R" string token in each
  //  HAS_ROW clause is the parameter ref; substituteToken replaces it with
  //  the integer row index at expansion time.
  // ---------------------------------------------------------------------------
  function buildRowFullOfBody() {
    const body = [];
    for (let c = 0; c < COLS; c++) {
      const p = `p${c}:Position`;
      const n = `n${c}:Position`;
      body.push([p, "HAS_ROW", "R"]);          // param-substituted to literal number
      body.push([p, "HAS_COL", c]);            // literal numeric column
      body.push(["NOT", n, "UPDATES", p]);     // current-position guard
    }
    return body;
  }

  // ---------------------------------------------------------------------------
  //  CSS — injected once, idempotent.
  // ---------------------------------------------------------------------------
  if (!document.getElementById("tetris-math-cartridge-styles")) {
    const style = document.createElement("style");
    style.id = "tetris-math-cartridge-styles";
    style.textContent = `
      .tm-cartridge { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 6px; }
      .tm-status { font-family: ui-monospace, monospace; font-size: 13px; color: rgba(255,255,255,0.85); letter-spacing: 0.3px; text-align: center; min-height: 18px; }
      .tm-status.over    { color: #ff5fa1; font-weight: 700; font-size: 15px; }
      .tm-status.cleared { color: #b8c7a8; font-weight: 700; }
      .tm-controls { display: flex; gap: 8px; }
      .tm-btn { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.85); padding: 4px 12px; border-radius: 4px; cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: 0.5px; }
      .tm-btn:hover    { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.35); }
      .tm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .tm-board { display: grid; background: rgba(255,255,255,0.05); padding: 4px; border-radius: 6px; }
      .tm-cell { width: 22px; height: 22px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.06); border-radius: 2px; box-sizing: border-box; }
      .tm-cell.locked    { background: rgba(184,199,168,0.55); border-color: rgba(184,199,168,0.75); }
      .tm-cell.falling   { background: rgba(255,0,111,0.75);   border-color: #ff006f; }
      .tm-cell.cleared   { background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.03); opacity: 0.35; }
      .tm-cell.cursor    { box-shadow: inset 0 0 0 2px #6ab0ff; border-color: #6ab0ff; }
      .tm-info { font-family: ui-monospace, monospace; font-size: 10px; color: rgba(255,255,255,0.4); letter-spacing: 0.3px; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  //  Cartridge — minimal: tick driver, spawn input, render projection.
  //
  //  Everything game-relevant lives in salt. The cartridge only:
  //    1. Mints fresh Tick concepts on a timer (the StepDown rule consumes
  //       one per pass).
  //    2. Spawns new Falling blocks when no falling block exists (random
  //       column — keyboard can move the spawn cursor).
  //    3. Projects current Positions → DOM grid cells. Cleared rows render
  //       with a dimmed style; falling blocks render hot-pink; locked blocks
  //       render olive.
  //
  //  Note: in this minimal cartridge, blocks land at row 24 (the floor) or
  //  on locked blocks, and cleared rows stay in the graph (with the IS
  //  Cleared tag). The pile doesn't visually "shift down" after clears —
  //  that would require either a sliding visible-window projection over a
  //  larger pre-allocated graph (Brandon's approach) or per-cell migration
  //  rules. We keep things straightforward here so the substrate is the
  //  thing on display, not projection cleverness.
  // ---------------------------------------------------------------------------
  pepper.registerCartridge("tetris-math", {
    name: "Tetris (math-native)",
    description: "Single-cell tetris on math-native salt. Bundle handles all game logic; cartridge does tick driver, spawn input, and render only.",
    bundle,
    mount(container, pep) {
      container.innerHTML = `
        <div class="tm-cartridge">
          <div class="tm-status" id="tm-status">ready</div>
          <div class="tm-controls">
            <button type="button" class="tm-btn" id="tm-play">play</button>
            <button type="button" class="tm-btn" id="tm-step">step once</button>
            <button type="button" class="tm-btn" id="tm-reset">reset</button>
          </div>
          <div class="tm-board" id="tm-board"></div>
          <div class="tm-info" id="tm-info">tick: 400ms · ← → move · ↓ drop · space rotate</div>
        </div>
      `;
      const statusEl = container.querySelector("#tm-status");
      const playBtn  = container.querySelector("#tm-play");
      const stepBtn  = container.querySelector("#tm-step");
      const resetBtn = container.querySelector("#tm-reset");
      const boardEl  = container.querySelector("#tm-board");
      const infoEl   = container.querySelector("#tm-info");
      boardEl.style.gridTemplateColumns = `repeat(${COLS}, 22px)`;
      // Build the 375 cell divs once and keep refs. Render then only writes
      // className strings on cells that changed — no innerHTML reparse, no
      // DOM thrash. The previous render-by-innerHTML approach was the
      // bottleneck on every arrow press (~11ms for 375 div rebuilds);
      // class-string compare + write is roughly 10× faster.
      const cellEls = new Array(ROWS * COLS);
      for (let i = 0; i < cellEls.length; i++) {
        const d = document.createElement("div");
        d.className = "tm-cell";
        boardEl.appendChild(d);
        cellEls[i] = d;
      }

      const TICK_MS = 400;
      let running    = false;
      let timerId    = null;
      let gameOver   = false;
      // Cartridge-side counters for fresh concept names. Initialized by
      // scanning the existing graph so reloads continue numbering past
      // whatever's already in there.
      const counters = { tick: 0, block: 0, pos: 0, move: 0 };
      function initCounters() {
        for (const n of state.graph.concepts.keys()) {
          let m;
          if ((m = n.match(/^Tick_(\d+)$/)))  counters.tick  = Math.max(counters.tick,  Number(m[1]));
          if ((m = n.match(/^Block_(\d+)$/))) counters.block = Math.max(counters.block, Number(m[1]));
          if ((m = n.match(/^Pos_(\d+)$/)))   counters.pos   = Math.max(counters.pos,   Number(m[1]));
          if ((m = n.match(/^MoveLeft_(\d+)$/)))  counters.move = Math.max(counters.move, Number(m[1]));
          if ((m = n.match(/^MoveRight_(\d+)$/))) counters.move = Math.max(counters.move, Number(m[1]));
        }
      }
      function freshName(kind) {
        const c = ++counters[kind === "Tick" ? "tick" : kind === "Block" ? "block" : "pos"];
        return `${kind}_${c}`;
      }

      // ---- graph queries (cartridge's read-only view) -----------------------
      // Walks contexts directly rather than going through pep.query so we can
      // batch lookups — render builds an occupancy map in one pass.
      function isPositionCurrent(p) {
        for (const u of state.graph.contextsNamed("UPDATES")) {
          if (u.target === p) return false;
        }
        return true;
      }
      function blockTags(block) {
        return state.graph.contextsFrom(block, "IS").map(c => c.target);
      }
      function findFallingBlock() {
        for (const t of state.graph.contextsNamed("IS")) {
          if (t.target !== "Falling") continue;
          const tags = blockTags(t.subject);
          if (!tags.includes("Locked")) return t.subject;
        }
        return null;
      }
      function clearedRows() {
        const out = new Set();
        for (const c of state.graph.contextsNamed("IS")) {
          if (c.target !== "Cleared") continue;
          const m = c.subject.match(/^Row_(\d+)$/);
          if (m) out.add(Number(m[1]));
        }
        return out;
      }
      // Occupancy: cell key "r_c" → "falling" | "locked" (most relevant state).
      // Three single passes over the named-predicate indices instead of doing
      // per-position contextsFrom lookups — keeps per-render work linear in
      // graph size, not quadratic over positions × predicates.
      function buildOccupancy() {
        const updates = state.graph.contextsNamed("UPDATES");
        const supr = new Set(updates.map(u => u.target));
        // Position → row/col maps.
        const rowOf = new Map();
        const colOf = new Map();
        for (const c of state.graph.contextsNamed("HAS_ROW")) rowOf.set(c.subject, c.target);
        for (const c of state.graph.contextsNamed("HAS_COL")) colOf.set(c.subject, c.target);
        // Block → state (locked > falling, since the matcher tags Locked
        // strictly after Falling and we want the dominant state). Walking
        // all IS triples once and remembering the winning state per block
        // beats calling contextsFrom(block, "IS") inside a loop.
        const blockState = new Map();
        for (const c of state.graph.contextsNamed("IS")) {
          if (c.target === "Locked") {
            blockState.set(c.subject, "locked");
          } else if (c.target === "Falling" && blockState.get(c.subject) !== "locked") {
            blockState.set(c.subject, "falling");
          }
        }
        const occ = new Map();
        for (const f of state.graph.contextsNamed("FOR")) {
          if (supr.has(f.subject)) continue;
          const st = blockState.get(f.target);
          if (!st) continue;
          const r = rowOf.get(f.subject);
          const col = colOf.get(f.subject);
          if (r === undefined || col === undefined) continue;
          occ.set(`${r}_${col}`, st);
        }
        return occ;
      }

      // ---- spawn ------------------------------------------------------------
      // Cartridge picks a random shape and tags the freshly-minted block
      // with it. The matching salt rule (ShapeI/O/L/T) then mints the 3
      // sibling cells at fixed offsets and tags the block IS Shaped. Until
      // it's Shaped, the StepDown rule won't fire — so on the spawn tick,
      // the shape rule runs first, then StepDown advances all 4 cells.
      const SHAPES = ["I_Shape", "O_Shape", "L_Shape", "T_Shape"];
      // Each shape's bounding-box width — used to clamp spawnCol so the
      // whole shape fits in the playfield.
      const SHAPE_WIDTH = { I_Shape: 4, O_Shape: 2, L_Shape: 3, T_Shape: 3 };
      function pickShape() {
        return SHAPES[Math.floor(Math.random() * SHAPES.length)];
      }
      function spawnBlock(col, shape) {
        const blkName = freshName("Block");
        const posName = freshName("Pos");
        state.graph.addConcept(blkName, ["Block"], "content");
        state.graph.addContext("IS", blkName, "Falling", "content");
        state.graph.addContext("IS", blkName, shape,     "content");
        state.graph.addConcept(posName, ["Position"], "content");
        state.graph.addContext("FOR",     posName, blkName, "content");
        state.graph.addContext("HAS_ROW", posName, 0,       "content");
        state.graph.addContext("HAS_COL", posName, col,     "content");
      }

      // ---- pruning: cartridge-side cleanup of consumed state ---------------
      // The bundle uses two patterns that, without cleanup, accumulate dead
      // state and turn the matcher's per-pass scans into O(N²) work:
      //
      //   1. Ticks are tagged IS Processed once consumed, but the Tick
      //      concept (and its IS-Tick / IS-Processed triples) stays in the
      //      graph forever. After N ticks, every fireToQuiescence iterates
      //      N IS-Tick triples to find unprocessed ones. We delete all
      //      Tick concepts before minting a fresh one — semantically a
      //      no-op (consumed Ticks contribute nothing to future rules)
      //      but a huge speedup.
      //
      //   2. As blocks fall, each step mints a new Position and tags it
      //      UPDATES <previous>. The previous Position is now superseded
      //      and never matches `NOT newer UPDATES p` again — it's dead
      //      weight in the contexts list. The bundle only ever does
      //      single-hop UPDATES checks (no transitive walks), so pruning
      //      superseded Positions is safe and keeps the graph linear in
      //      live game state rather than total history.
      //
      // Both operations are housekeeping, not gameplay — the cartridge owns
      // them because salt is intentionally additive and doesn't unsay things.
      function pruneConcept(name) {
        for (const c of [...state.graph.contexts]) {
          if (c.subject === name || c.target === name) state.graph.removeContext(c);
        }
        state.graph.removeConcept(name);
      }
      function pruneTicks() {
        const ticks = [];
        for (const c of state.graph.concepts.values()) {
          if (c.types && c.types.includes("Tick")) ticks.push(c.name);
        }
        for (const n of ticks) pruneConcept(n);
      }
      function pruneSupersededPositions() {
        // A Position p is superseded iff some other Position has UPDATES p.
        // The successor stands in for it from now on; the bundle's rules
        // never look back through the chain. Safe to delete.
        const superseded = new Set();
        for (const u of state.graph.contextsNamed("UPDATES")) {
          superseded.add(u.target);
        }
        for (const n of superseded) pruneConcept(n);
      }

      // ---- game-over check --------------------------------------------------
      // The pile has reached the top when row 0 has any locked cell. With
      // no falling block, we can't spawn, so the game ends.
      function pileAtTop(occ) {
        for (let c = 0; c < COLS; c++) {
          if (occ.get(`0_${c}`) === "locked") return true;
        }
        return false;
      }

      // ---- tick: spawn (if needed), mint Tick, fire ------------------------
      function tick() {
        if (gameOver) return;
        // Housekeeping: drop consumed Ticks and superseded Positions before
        // adding new work. Without this, the matcher's per-pass scans grow
        // O(N) in turn count and the game gets exponentially slower.
        pruneTicks();
        pruneSupersededPositions();
        const falling = findFallingBlock();
        if (!falling) {
          const occ = buildOccupancy();
          if (pileAtTop(occ)) {
            gameOver = true;
            stopRunning();
            render();
            return;
          }
          const shape = pickShape();
          // Random column within range; clamp to fit shape width.
          const w = SHAPE_WIDTH[shape];
          const col = Math.floor(Math.random() * (COLS - w + 1));
          spawnBlock(col, shape);
        }
        const tickName = freshName("Tick");
        state.graph.addConcept(tickName, ["Tick"], "content");
        fireToQuiescence();
        render();
      }

      function startRunning() {
        if (running || gameOver) return;
        timerId = setInterval(tick, TICK_MS);
        running = true;
        playBtn.textContent = "pause";
        stepBtn.disabled = true;
        render();
      }
      function stopRunning() {
        if (timerId) clearInterval(timerId);
        timerId = null;
        running = false;
        playBtn.textContent = gameOver ? "game over" : "play";
        playBtn.disabled = gameOver;
        stepBtn.disabled = gameOver;
      }

      // ---- render -----------------------------------------------------------
      function render() {
        const occ = buildOccupancy();
        const cleared = clearedRows();
        const falling = findFallingBlock();
        for (let r = 0; r < ROWS; r++) {
          const isCleared = cleared.has(r);
          for (let c = 0; c < COLS; c++) {
            const o = occ.get(`${r}_${c}`);
            let cls = "tm-cell";
            if (isCleared)       cls += " cleared";
            if (o === "locked")  cls += " locked";
            if (o === "falling") cls += " falling";
            const cell = cellEls[r * COLS + c];
            if (cell.className !== cls) cell.className = cls;
          }
        }
        if (gameOver) {
          statusEl.textContent = "GAME OVER";
          statusEl.className = "tm-status over";
        } else if (cleared.size > 0) {
          statusEl.textContent = `cleared rows: ${cleared.size}`;
          statusEl.className = "tm-status cleared";
        } else if (running) {
          statusEl.textContent = falling ? "falling…" : "spawning…";
          statusEl.className = "tm-status";
        } else {
          statusEl.textContent = falling ? "paused (block falling)" : "ready";
          statusEl.className = "tm-status";
        }
        infoEl.textContent = `tick: ${TICK_MS}ms · ← → move · ↓ drop · space rotate`;
      }

      // ---- input actions (salt-side and cartridge-side) ---------------------
      // Left/Right: salt rules. Mint a fresh MoveLeft/MoveRight concept and
      // fire ONLY the three move-relevant implications instead of running a
      // full fireToQuiescence over all 39 implications (4 shape + 6 move +
      // 4 step/land + 25 parametric RowFull). The full-quiescence cost was
      // dominated by RowFull's 25 × 45-clause OF bodies, even though row
      // clears can't possibly trigger from a lateral shift alone. Three
      // targeted fires bring the per-keypress cost down to single-digit ms.
      function tryMove(direction) {
        if (gameOver) return;
        if (!findFallingBlock()) return;
        const prefix = direction === "left" ? "MoveLeft" : "MoveRight";
        const name = `${prefix}_${++counters.move}`;
        state.graph.addConcept(name, [prefix], "content");
        const budget = { maxConcepts: state.graph.concepts.size + 50 };
        state.runner.fireImplication(`${prefix}BlockedEdge`,   budget);
        state.runner.fireImplication(`${prefix}BlockedLocked`, budget);
        state.runner.fireImplication(`${prefix}Do`,            budget);
        pruneSupersededPositions();
        pruneConcept(name);
        render();
      }

      // Space: rotation. Done cartridge-side for now (rules-heavy rotation
      // is doable — 4 shapes × 4 orientations = 16 rules — but expensive
      // to author and rebuild for each shape edit; cartridge geometry is
      // a few lines). Each block has its bounding-box top-left
      // ("anchor") and a tetromino-specific rotation table; pressing
      // Space looks up the next orientation's cell offsets relative to
      // the anchor, validates that the rotated cells fit on the board
      // and don't overlap any locked cell, and if valid mints 4 new
      // Positions UPDATES the current 4.
      const ROTATIONS = {
        I_Shape: [
          [[0,0],[0,1],[0,2],[0,3]],  // R0 horizontal
          [[0,0],[1,0],[2,0],[3,0]],  // R1 vertical
        ],
        O_Shape: [
          [[0,0],[0,1],[1,0],[1,1]],  // no rotation
        ],
        L_Shape: [
          [[0,0],[1,0],[1,1],[1,2]],  // R0
          [[0,0],[0,1],[1,0],[2,0]],  // R1
          [[0,0],[0,1],[0,2],[1,2]],  // R2
          [[0,1],[1,1],[2,0],[2,1]],  // R3
        ],
        T_Shape: [
          [[0,0],[0,1],[0,2],[1,1]],  // R0
          [[0,0],[1,0],[2,0],[1,1]],  // R1 (T pointing right)
          [[0,1],[1,0],[1,1],[1,2]],  // R2 (T pointing up)
          [[0,1],[1,0],[1,1],[2,1]],  // R3 (T pointing left)
        ],
      };
      // Track current rotation per block, cartridge-side. Cleared on prune.
      const blockOrientation = new Map();
      function tryRotate() {
        if (gameOver) return;
        const block = findFallingBlock();
        if (!block) return;
        const tags = blockTags(block);
        const shape = tags.find(t => ROTATIONS[t]);
        if (!shape) return;
        const variants = ROTATIONS[shape];
        if (variants.length === 1) return;  // O_Shape — no rotation
        const cur = blockOrientation.get(block) || 0;
        const next = (cur + 1) % variants.length;
        // Find current cells of the block (current = no newer UPDATES).
        const supr = new Set(state.graph.contextsNamed("UPDATES").map(u => u.target));
        const cells = [];
        for (const f of state.graph.contextsNamed("FOR")) {
          if (f.target !== block || supr.has(f.subject)) continue;
          const r = state.graph.contextsFrom(f.subject, "HAS_ROW")[0];
          const c = state.graph.contextsFrom(f.subject, "HAS_COL")[0];
          if (r && c) cells.push({ p: f.subject, r: r.target, c: c.target });
        }
        if (cells.length !== 4) return;  // shouldn't happen for a Shaped block
        // Anchor: top-left of the current bounding box (matches the way the
        // shape was minted — spawn cell + offsets in the R-table).
        const minR = Math.min(...cells.map(c => c.r));
        const minC = Math.min(...cells.map(c => c.c));
        const newOffsets = variants[next];
        const newCells = newOffsets.map(([dr, dc]) => ({ r: minR + dr, c: minC + dc }));
        // Collision check: bounds + no overlap with locked cells.
        for (const nc of newCells) {
          if (nc.r < 0 || nc.r >= ROWS || nc.c < 0 || nc.c >= COLS) return;
        }
        const occ = buildOccupancy();
        for (const nc of newCells) {
          const k = `${nc.r}_${nc.c}`;
          if (occ.get(k) === "locked") return;
        }
        // Valid rotation. Mint 4 new Positions superseding the current 4.
        for (let i = 0; i < 4; i++) {
          const old = cells[i];
          const fresh = freshName("Pos");
          state.graph.addConcept(fresh, ["Position"], "content");
          state.graph.addContext("FOR",     fresh, block,        "content");
          state.graph.addContext("HAS_ROW", fresh, newCells[i].r, "content");
          state.graph.addContext("HAS_COL", fresh, newCells[i].c, "content");
          state.graph.addContext("UPDATES", fresh, old.p,        "content");
        }
        blockOrientation.set(block, next);
        pruneSupersededPositions();
        render();
      }

      // ---- keyboard ---------------------------------------------------------
      // Listen on `window` with capture so we get keys before any editor-level
      // bubble-phase handler can intercept them. Container is focusable +
      // auto-focused so the cartridge is the obvious recipient of keystrokes;
      // a click anywhere in the cartridge re-focuses it. Skip everything when
      // the user is typing in a real text input.
      container.tabIndex = 0;
      container.style.outline = "none";
      container.focus();
      container.addEventListener("mousedown", () => container.focus());
      function onKey(e) {
        if (gameOver) return;
        const tgt = e.target;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        if (e.key === "ArrowLeft") {
          tryMove("left"); e.preventDefault(); e.stopPropagation();
        } else if (e.key === "ArrowRight") {
          tryMove("right"); e.preventDefault(); e.stopPropagation();
        } else if (e.key === "ArrowDown") {
          // Fast drop: send one extra Tick. The cartridge tick handler does
          // the rest (mints Tick concept, fires; StepDown advances all cells).
          tick(); e.preventDefault(); e.stopPropagation();
        } else if (e.key === " " || e.code === "Space") {
          tryRotate(); e.preventDefault(); e.stopPropagation();
        }
      }
      window.addEventListener("keydown", onKey, true);

      // ---- buttons ----------------------------------------------------------
      playBtn.addEventListener("click", () => running ? stopRunning() : startRunning());
      stepBtn.addEventListener("click", () => { if (!running && !gameOver) tick(); });
      resetBtn.addEventListener("click", () => {
        // Wipe content layer; bundle stays imported.
        const toRemove = [];
        for (const c of state.graph.concepts.values()) {
          if (c.layer === "content") toRemove.push(c.name);
        }
        for (const n of toRemove) {
          for (const ctx of [...state.graph.contextsFrom(n)]) state.graph.removeContext(ctx);
          for (const ctx of state.graph.contextsNamed("FOR").filter(c => c.target === n)) state.graph.removeContext(ctx);
          state.graph.removeConcept(n);
        }
        // Remove content-layer triples on non-content concepts (Cleared tags
        // on bundle-layer Row_N concepts).
        for (const c of [...state.graph.contexts]) {
          if (c.layer === "content") state.graph.removeContext(c);
        }
        counters.tick = counters.block = counters.pos = 0;
        gameOver = false;
        stopRunning();
        render();
      });

      // ---- init -------------------------------------------------------------
      initCounters();
      render();

      // Cleanup on unmount.
      return () => {
        if (timerId) clearInterval(timerId);
        window.removeEventListener("keydown", onKey, true);
      };
    },
  });
})();
