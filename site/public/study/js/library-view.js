import { courseDescription } from "./library-descriptions.js?release=v40-learner-graph";

function normalizedSearchText(values) {
  return values
    .flat(Infinity)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export function matchesLibraryQuery(deck, query) {
  const tokens = normalizedSearchText([query]).split(" ").filter(Boolean);
  if (!tokens.length) return true;
  const searchText = deck.searchText ?? normalizedSearchText([
    deck.title,
    deck.subject,
    deck.domain,
    deck.level,
    deck.description,
    deck.coverageSummary,
    deck.crossListedSubjects,
    deck.tags,
    (deck.modules ?? []).flatMap((module) => [module.title, module.description]),
    (deck.cards ?? []).flatMap((card) => [card.term, card.aliases, card.module, card.tags]),
  ]);
  return tokens.every((token) => searchText.includes(token));
}

// Presentation only. Catalog content and learner records are never rewritten.
export function presentLibrary(catalog, { crossListings = {} } = {}) {
  return catalog.map((deck) => {
    const moduleTitles = new Map((deck.modules ?? []).map((module) => [module.module_id ?? module.id, module.title]));
    const cards = (deck.cards ?? []).map((card) => ({
      ...card,
      module: card.module ?? (card.module_ids ?? card.moduleIds ?? []).map((id) => moduleTitles.get(id) ?? id).join(", "),
    }));
    const description = courseDescription(deck);
    return {
      ...deck,
      cardCount: deck.cardCount ?? cards.length,
      cards,
      description,
      coverageSummary: description,
      crossListedSubjects: crossListings[deck.id] ?? [],
      searchText: normalizedSearchText([
        deck.title,
        deck.subject,
        deck.domain,
        deck.level,
        description,
        crossListings[deck.id] ?? [],
        deck.tags ?? [],
        (deck.modules ?? []).flatMap((module) => [module.title, module.description]),
        cards.flatMap((card) => [card.term, card.aliases, card.module, card.tags]),
      ]),
    };
  });
}

// Preview only the selected course. Cross-course relations remain compatible
// in retained source data but are intentionally absent from learner-facing
// Library and Graph behavior.
export function graphForCatalog(deck) {
  const cardsById = new Map((deck.cards ?? []).map((card) => [card.id, card]));
  const rootCardIds = (deck.cards ?? []).map((card) => card.id);
  const rootIds = new Set(rootCardIds);
  const cards = rootCardIds.map((id) => {
    const card = cardsById.get(id);
    const prerequisites = [...new Set(
      card.prerequisites ?? card.prerequisiteIds ?? card.prerequisite_ids ?? [],
    )].filter((parentId) => rootIds.has(parentId));
    return {
      ...card,
      prerequisites,
      module: {
        id: `${deck.id}:concepts`,
        title: "Concept",
      },
      ownerDeckId: deck.id,
      ownerDeckTitle: deck.title,
      external: false,
    };
  });
  return {
    id: deck.id,
    title: deck.title,
    subject: deck.subject,
    level: deck.level,
    version: deck.version,
    description: deck.description,
    cards,
    edges: [],
    rootCardIds,
    missingPrerequisiteIds: [],
  };
}

// Draw only the saved personal course. Deck-local learning order remains
// visible; retained cross-course references never expand the graph.
export function graphForPersonal(deck) {
  const cards = new Map();
  const missing = new Set();
  const queue = deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived);
  const rootIds = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (cards.has(id)) continue;
    const card = deck.cards[id];
    if (!card || card.archived) { missing.add(id); continue; }
    const prerequisites = [...new Set([...(card.prerequisiteIds ?? []), ...(deck.edges ?? [])
      .filter((edge) => edge.dependentCardId === id).map((edge) => edge.prerequisiteCardId)])];
    const moduleId = card.moduleIds?.[0] ?? "concepts";
    const module = deck.modules?.find((item) => (item.module_id ?? item.id) === moduleId);
    const title = module?.title ?? (moduleId === "concepts" ? "Concepts" : moduleId);
    const localPrerequisites = prerequisites.filter((parentId) => {
      if (rootIds.has(parentId)) return true;
      if (Object.prototype.hasOwnProperty.call(deck.cards, parentId)) missing.add(parentId);
      return false;
    });
    cards.set(id, { ...card, prerequisites: localPrerequisites,
      module: { id: `${deck.id}:${moduleId}`, title },
      ownerDeckId: deck.id, ownerDeckTitle: deck.title, external: false });
  }
  return {
    id: deck.id, title: deck.title, subject: deck.subject, level: deck.level,
    version: String(deck.revision), description: deck.description,
    cards: [...cards.values()], rootCardIds: [...rootIds], missingPrerequisiteIds: [...missing],
  };
}
