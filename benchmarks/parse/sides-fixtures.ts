// Shared fixtures for the parse benchmarks: the sides PDFs in test_data
// (gitignored — copy them in locally) and each file's known ground truth.
// sides-parse.ts asserts the deterministic parser against these;
// strategy-compare.ts scores every parse strategy against the same answers.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdfLayout, type PdfLayoutResult } from "../../src/lib/pdf";
import { cleanLayoutLines, type LayoutLineTuple } from "../../api/_layout.js";
import { applySidesMarkup } from "../../api/_sides.js";

export const TEST_DATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test_data",
);

export const fixtureExists = (fileName: string) =>
  existsSync(join(TEST_DATA, fileName));

export const readFixture = (fileName: string) =>
  readFileSync(join(TEST_DATA, fileName));

export type ExtractedSides = {
  extracted: PdfLayoutResult;
  /** Every cleaned layout line, before the START/END selection is applied. */
  cleanedLines: LayoutLineTuple[];
  /** Lines inside the selection — what every server strategy receives. */
  lines: LayoutLineTuple[];
  cuesApplied: boolean;
};

/** Run the real client extraction and sides markup over a test PDF. */
export async function extractSides(fileName: string): Promise<ExtractedSides> {
  const { getDocument } = await import("pdfjs-dist");
  const data = new Uint8Array(readFixture(fileName));
  const document = await getDocument({ data }).promise;
  const extracted = await extractPdfLayout(
    undefined as unknown as File,
    document,
  );
  await document.destroy();

  const cleaned = cleanLayoutLines(extracted.lines);
  const sided = applySidesMarkup(cleaned.lines);
  return {
    extracted,
    cleanedLines: cleaned.lines,
    lines: sided.lines,
    cuesApplied: sided.cuesApplied,
  };
}

export type Expectation = {
  file: string;
  /** Route to vision instead of asserting text content. */
  expectVision?: boolean;
  /** Substrings that must survive in the parsed text. */
  includes?: string[];
  /** Substrings that must NOT appear (cut/hidden/out-of-selection content). */
  excludes?: string[];
  /** Substrings that must be parsed as spoken lines, not stage directions. */
  verbalIncludes?: string[];
  /** Speaking characters the layout parse must find (subset match). */
  characters?: string[];
  expectSidesDetected?: boolean;
};

export const EXPECTATIONS: Expectation[] = [
  {
    file: "LOLLY_SIDES_1-_KILL_ROYALE.pdf",
    expectSidesDetected: true,
    includes: [
      "Zero drops spilled, bitches!", // selection starts at Lolly's entrance
      "LOLLY (40s), in a white party gown", // START snaps to the paragraph top
      "How may they help you?", // last line of the selection
      "Have some kind", // margin note carried as a cue
    ],
    excludes: [
      "SECURITY CAM FOOTAGE", // scene 52, crossed out by the diagonal slash
      "He bangs on the door", // slashed
      "Hello? Hello?", // scene 54, after the END cue
      "rusted shopping cart", // after the END cue
    ],
    characters: ["LOLLY", "ANDREA"],
  },
  {
    file: "ANDREA_SIDES_1-_KILL_ROYALE.pdf",
    expectSidesDetected: true,
    includes: [
      "I think I’m smattered.", // START points at Lolly's first line
      "How may they help you?", // selection end
    ],
    excludes: [
      "He bangs on the door", // slashed block on page 1
      "Hey, I’m outside", // Ryan's scene after END, also slashed
      "Coolers of beer", // slashed on page 2
    ],
    characters: ["LOLLY", "ANDREA"],
  },
  {
    file: "SILAS_JENKINS_03.02.26.pdf",
    expectSidesDetected: true,
    includes: [
      "Tobias MacIvey!", // first line of the selection
      "Ow, ow, owoooooo!", // last line before Stop
    ],
    excludes: [
      "Dissipating fog", // scene 18, white-boxed (text still in the layer!)
      "Alligators lurk", // white-boxed
      "Zech saunters", // scene 21 after Stop, white-boxed
      "rendering bees wax", // scene 22 after Stop
    ],
    characters: ["SILAS JENKINS", "TOBIAS"],
  },
  {
    file: "CANNED_-_CARL_Sides_3.10.26.pdf",
    expectSidesDetected: true,
    includes: [
      "It’s pointless. You’ll never get it", // SC 1 starts at Ethan's line
      "What the hell is this place?", // SC 1 ends here
      "Caity. Will you marry me?", // SC 2 selection start
      "We are here to sell not soil", // unstruck remainder of Ethan's speech
      "You think you can just", // unstruck remainder of Secretary's speech
    ],
    excludes: [
      "That is not yours!", // page 1 content before START (hidden by cover)
      "as serious as our sales target", // struck sentence inside kept dialogue
      "tin can was invented", // struck sentence
      "should be celebrating", // struck sentence (SC 2)
      "no one is saying you", // struck speech after SC 2's END
      "PG 1 OF 7", // sides furniture
    ],
    verbalIncludes: [
      // Speech whose first row opens with struck text keeps its dialogue
      // column, so it stays Ethan's line instead of becoming a direction.
      "We are here to sell not soil ourselves",
      "You think you can just sit there",
      // Dialogue sharing a row with a leading parenthetical stays spoken.
      "Wrong! Your job is to sell cans",
    ],
    characters: ["ETHAN", "CARL", "SECRETARY"],
  },
  {
    file: "LINDA_Sides.pdf",
    expectSidesDetected: true,
    includes: [
      "We need to leave now, Mom!", // Scene 1 selection start
      "Not now.", // Scene 1 selection end
      "If we take him back there", // Scene 2 selection start
      "Call the airline?", // Scene 2 selection end
    ],
    excludes: [
      "Larus Californicus", // page 1, before any Start cue
      "Western Snowy Plover", // FYI section (vertical-line rule)
      "car now in motion", // after Scene 1's End cue
      "You’ve done all you can", // after Scene 2's End cue
    ],
    characters: ["LINDA", "ROBBY", "SAM"],
  },
  {
    // Actors Access sides: markup is a raster overlay — geometry can't read
    // it, so the extractor must route the document to the vision parser.
    file: "BEVERLY.pdf",
    expectVision: true,
  },
  {
    // Plain screenplay with no sides markup: the sides machinery must stay
    // entirely out of the way.
    file: "the-marvelous-mrs-maisel-101-pilot-2017.pdf",
    expectSidesDetected: false,
    includes: ["MIDGE"],
    characters: ["MIDGE"],
  },
];
