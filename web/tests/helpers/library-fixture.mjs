import { createHash } from "node:crypto";

import { prepareLibraryCatalog } from "../../js/library-catalog.js";

export const FIXTURE_VERSION = "synthetic-reviewed.v1";
export const catalogId = (sourceId) => `academic-reviewed-v1:${sourceId}`;

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Independent fixture encoding: this does not call the adapter's hash helpers.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const digest = (value) => `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;

function defaultDefinitions() {
  const card = (id, prerequisite_ids = []) => ({
    id,
    term: id,
    definition: `  Synthetic definition of ${id}.\r\nPreserve this whitespace.  `,
    required_concepts: ["  State the synthetic definition.  "],
    prerequisite_ids,
  });
  return [
    ["alpha", [card("alpha.root")]],
    ["beta", [card("beta.branch", ["alpha.root"])]],
    ["delta", [card("delta.branch", ["alpha.root"])]],
    ["gamma", [card("gamma.tip", ["beta.branch", "delta.branch"])]],
  ];
}

/**
 * Entirely synthetic, in-memory Library input. The paths and source hashes are
 * invented fixture identities, never paths to corpus or learner data. The
 * returned feed keeps the candidate's private guards; preparation is not source
 * authorization, semantic review, rights clearance or release acceptance.
 */
export async function preparedFixture(definitions = defaultDefinitions()) {
  const sourceDefinitions = structuredClone(definitions);
  const sourceReferenceMap = Object.create(null);
  const catalog = sourceDefinitions.map(([sourceId, cards]) => ({
    id: catalogId(sourceId),
    version: FIXTURE_VERSION,
    title: `Synthetic ${sourceId}`,
    subject: "Synthetic",
    domain: "Synthetic",
    review_status: "synthetic-test-only",
    content_status: "private-candidate-not-admitted",
    evidence_tier: "synthetic-mechanics-fixture",
    rights_status: "not-cleared",
    license: null,
    cards: cards.map((raw, index) => {
      const referenceId = `private-source-sha256:${digest({ sourceId, cardId: raw.id }).slice(7)}`;
      sourceReferenceMap[referenceId] = {
        artifact_path: `synthetic-private-source-canary/${sourceId}.json`,
        artifact_sha256: digest({ sourceId, cards }),
        json_pointer: `/cards/${index}/source_refs/0`,
      };
      return {
        prompt: null,
        aliases: [],
        accepted_variants: [],
        major_error_concepts: [],
        source_refs: [referenceId],
        tags: [],
        ...raw,
        canonical_deck_id: sourceId,
      };
    }),
    edges: [],
  })).sort((left, right) => compare(left.id, right.id));

  const feed = {
    projection_schema_version: "meshful-library-catalog-input.v1",
    audience: "private",
    public_release_approved: false,
    rights_status: "not-cleared",
    current_runtime_compatible: false,
    catalog,
    dependency_edges: [],
    source_card_index: Object.create(null),
    runtime_identity_map: {
      normalization_version: "canonical-library-card-identity.v1",
      rule: "Synthetic canonical card IDs stay unchanged.",
      decks: [],
      cards: Object.create(null),
    },
    source_reference_map: sourceReferenceMap,
    catalog_ref: { version: FIXTURE_VERSION, digest: "" },
    dependency_graph_sha256: "",
  };
  const sourceCards = new Map(sourceDefinitions);
  const owners = new Map(catalog.flatMap((deck) => deck.cards.map((card) => [card.id, card.canonical_deck_id])));
  for (const deck of catalog) {
    const sourceId = deck.cards[0].canonical_deck_id;
    const artifactDigest = digest({ sourceId, cards: sourceCards.get(sourceId) });
    feed.runtime_identity_map.decks.push({
      source_deck_id: sourceId, catalog_deck_id: deck.id,
      catalog_deck_version: deck.version, personal_deck_id: null,
    });
    deck.cards.forEach((card, index) => {
      feed.source_card_index[card.id] = {
        source_deck_id: sourceId, catalog_deck_id: deck.id,
        artifact_sha256: artifactDigest,
        artifact_path: `synthetic-private-source-canary/${sourceId}.json`,
        json_pointer: `/cards/${index}`,
      };
      feed.runtime_identity_map.cards[card.id] = {
        source_card_id: card.id, runtime_card_id: card.id,
        catalog_deck_id: deck.id, personal_deck_id: null,
      };
      for (const parent of card.prerequisite_ids) {
        feed.dependency_edges.push({
          prerequisite_card_id: parent, dependent_card_id: card.id,
          prerequisite_source_deck_id: owners.get(parent), dependent_source_deck_id: sourceId,
          requirement: "required", gate: "first_introduction",
        });
      }
    });
  }
  feed.dependency_edges.sort((left, right) => compare(left.prerequisite_card_id, right.prerequisite_card_id)
    || compare(left.dependent_card_id, right.dependent_card_id));
  for (const deck of catalog) {
    const sourceId = deck.cards[0].canonical_deck_id;
    deck.edges = feed.dependency_edges
      .filter((edge) => edge.prerequisite_source_deck_id === sourceId && edge.dependent_source_deck_id === sourceId)
      .map(({ prerequisite_card_id, dependent_card_id }) => ({ prerequisite_card_id, dependent_card_id }));
  }
  feed.catalog_ref.digest = digest(catalog);
  feed.dependency_graph_sha256 = digest(feed.dependency_edges);
  return { feed, prepared: await prepareLibraryCatalog(feed) };
}
