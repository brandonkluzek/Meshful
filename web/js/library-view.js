// Presentation only. Catalog content and learner records are never rewritten.
export function presentLibrary(catalog, { crossListings = {} } = {}) {
  return catalog.map((deck) => {
    const moduleTitles = new Map((deck.modules ?? []).map((module) => [module.module_id ?? module.id, module.title]));
    const cards = deck.cards.map((card) => ({
      ...card,
      module: card.module ?? (card.module_ids ?? card.moduleIds ?? []).map((id) => moduleTitles.get(id) ?? id).join(", "),
    }));
    return {
      ...deck,
      cardCount: cards.length,
      cards,
      description: deck.description ?? "",
      coverageSummary: deck.coverageSummary ?? deck.description ?? "",
      crossListedSubjects: crossListings[deck.id] ?? [],
      searchText: [deck.title, deck.subject, ...(crossListings[deck.id] ?? []), ...(deck.tags ?? []),
        ...cards.flatMap((card) => [card.term, ...(card.aliases ?? [])])].join(" ").toLocaleLowerCase(),
    };
  });
}

// Draw saved personal content, not the latest Library's similarly named deck.
// Only exact required external ancestors join the graph; the entire catalog is
// never expanded into the visible graph or copied into learner storage.
export function graphForPersonal(deck, snapshot) {
  const sameRelease = (candidate) => !deck.libraryBase || (
    candidate.libraryBase?.catalogRef?.version === deck.libraryBase.catalogRef.version &&
    candidate.libraryBase?.catalogRef?.digest === deck.libraryBase.catalogRef.digest
  );
  const owners = new Map();
  const cards = new Map();
  const missing = new Set();
  const candidates = deck.libraryBase
    ? Object.values(snapshot.personalDecks ?? {}).filter((candidate) => !candidate.archived && sameRelease(candidate))
    : [deck];
  for (const candidate of candidates) {
    for (const id of candidate.cardOrder) {
      if (candidate.cards[id] && !candidate.cards[id].archived) owners.set(id, candidate);
    }
  }
  const queue = deck.cardOrder.filter((id) => deck.cards[id] && !deck.cards[id].archived);
  const rootIds = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    if (cards.has(id)) continue;
    const owner = rootIds.has(id) ? deck : owners.get(id);
    const card = owner?.cards[id];
    if (!card || card.archived) { missing.add(id); continue; }
    const prerequisites = [...new Set([...(card.prerequisiteIds ?? []), ...(owner.edges ?? [])
      .filter((edge) => edge.dependentCardId === id).map((edge) => edge.prerequisiteCardId)])];
    const moduleId = card.moduleIds?.[0] ?? "concepts";
    const module = owner.modules?.find((item) => (item.module_id ?? item.id) === moduleId);
    const title = module?.title ?? (moduleId === "concepts" ? "Concepts" : moduleId);
    cards.set(id, { ...card, prerequisites: [...prerequisites],
      module: { id: `${owner.id}:${moduleId}`, title: owner.id === deck.id ? title : `${owner.title} · ${title}` },
      ownerDeckId: owner.id, ownerDeckTitle: owner.title, external: owner.id !== deck.id });
    for (const parent of prerequisites) if (!cards.has(parent)) queue.push(parent);
  }
  // Missing/archived prerequisites stay explicit in a graph notice; the store
  // remains the sole eligibility authority. Do not invent placeholder cards.
  for (const card of cards.values()) card.prerequisites = card.prerequisites.filter((id) => cards.has(id));
  return {
    id: deck.id, title: deck.title, subject: deck.subject, level: deck.level,
    version: String(deck.revision), description: deck.description,
    cards: [...cards.values()], rootCardIds: [...rootIds], missingPrerequisiteIds: [...missing],
  };
}
