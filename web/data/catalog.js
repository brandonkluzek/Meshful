const EXAMPLE_METADATA = Object.freeze({
  curator: "Meshful public examples",
  updatedDate: "2026-09-02",
  provenance: "owner_commissioned_public_example",
  reviewStatus: "not_independently_reviewed",
  contentStatus: "original_public_example",
  licenseStatus: "cc0-1.0",
});

function card(id, term, definition, module, prerequisites = [], sourceRefs = []) {
  return Object.freeze({
    id,
    term,
    definition,
    module,
    prerequisites: Object.freeze([...prerequisites]),
    sourceRefs: Object.freeze([...sourceRefs]),
  });
}

function deck({ cards, tags, ...metadata }) {
  const frozenCards = Object.freeze([...cards]);
  return Object.freeze({
    ...metadata,
    ...EXAMPLE_METADATA,
    cardCount: frozenCards.length,
    tags: Object.freeze([...tags]),
    cards: frozenCards,
  });
}

const linearAlgebraCards = [
  card(
    "la-scalar",
    "Scalar",
    "A scalar is one value from the number system used to scale vectors in a vector space.",
    "Vectors",
    [],
    ["https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/pages/calendar/"],
  ),
  card(
    "la-vector",
    "Vector",
    "A vector is an element of a vector space; in coordinates, it can be represented by an ordered list of scalars.",
    "Vectors",
    [],
    ["https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/pages/calendar/"],
  ),
  card(
    "la-linear-combination",
    "Linear combination",
    "A linear combination is a sum formed by multiplying vectors by scalars and adding the resulting vectors.",
    "Vectors",
    ["la-scalar", "la-vector"],
    ["https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/9cef4e6897e0d0369ef68d26fd19aff2_MIT18_06S10_L05.pdf"],
  ),
  card(
    "la-span",
    "Span",
    "The span of a set of vectors is the set of every linear combination that can be formed from those vectors.",
    "Vectors",
    ["la-linear-combination"],
    ["https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/0fab20a14c050d85ef29563cd6c52d37_MIT18_06S10_L09.pdf"],
  ),
];

const mechanicsCards = [
  card("mech-position", "Position", "Position locates an object relative to a chosen origin and coordinate frame.", "Motion", [], ["https://openstax.org/books/university-physics-volume-1/pages/3-1-position-displacement-and-average-velocity"]),
  card("mech-displacement", "Displacement", "Displacement is the vector change from an object's initial position to its final position.", "Motion", ["mech-position"], ["https://openstax.org/books/university-physics-volume-1/pages/3-1-position-displacement-and-average-velocity"]),
  card("mech-velocity", "Velocity", "Velocity describes how position changes with time, including the direction of that change.", "Motion", ["mech-displacement"], ["https://openstax.org/books/university-physics-volume-1/pages/3-summary"]),
  card("mech-acceleration", "Acceleration", "Acceleration describes how velocity changes with time, whether in magnitude, direction, or both.", "Motion", ["mech-velocity"], ["https://openstax.org/books/university-physics-volume-1/pages/3-summary"]),
  card("mech-mass", "Mass", "Mass measures an object's inertia: how strongly it resists acceleration under an applied net force.", "Forces", [], ["https://openstax.org/books/university-physics-volume-1/pages/5-2-newtons-first-law"]),
  card("mech-force", "Force", "A force is a vector interaction, such as a push or pull, that can change an object's motion.", "Forces", ["mech-acceleration"], ["https://openstax.org/books/university-physics-volume-1/pages/5-1-forces"]),
  card("mech-net-force", "Net force", "Net force is the vector sum of the external forces acting on the chosen system.", "Forces", ["mech-force"], ["https://openstax.org/books/university-physics-volume-1/pages/5-summary"]),
  card("mech-inertia", "Inertia", "Inertia is an object's tendency to maintain its state of rest or constant-velocity motion.", "Forces", ["mech-mass", "mech-velocity"], ["https://openstax.org/books/university-physics-volume-1/pages/5-2-newtons-first-law"]),
  card("mech-newton-second-law", "Newton's second law", "Newton's second law relates net external force to the rate of change of momentum; for constant mass, it becomes net force equals mass times acceleration.", "Forces", ["mech-net-force", "mech-mass", "mech-acceleration"], ["https://openstax.org/books/university-physics-volume-1/pages/5-3-newtons-second-law"]),
  card("mech-momentum", "Momentum", "Linear momentum is a vector equal to an object's mass multiplied by its velocity.", "Energy and momentum", ["mech-mass", "mech-velocity"], ["https://openstax.org/books/university-physics-volume-1/pages/9-1-linear-momentum"]),
  card("mech-work", "Work", "Work done by a force is the integral of the force dotted with displacement along the object's path.", "Energy and momentum", ["mech-force", "mech-displacement"], ["https://openstax.org/books/university-physics-volume-1/pages/7-1-work"]),
  card("mech-kinetic-energy", "Kinetic energy", "In classical mechanics, a particle's kinetic energy is one half its mass multiplied by the square of its speed.", "Energy and momentum", ["mech-mass", "mech-velocity", "mech-work"], ["https://openstax.org/books/university-physics-volume-1/pages/7-2-kinetic-energy"]),
];

const softwareEngineeringCards = [
  card(
    "se-dependency-graph",
    "Dependency graph",
    "A dependency graph represents software components as nodes and dependency relationships as directed edges whose direction convention is stated explicitly.",
    "Build systems",
    [],
    [
      "https://docs.gradle.org/current/userguide/dependency_graph_resolution.html",
      "https://learn.microsoft.com/en-us/archive/msdn-magazine/2009/april/parallelizing-operations-with-dependencies",
    ],
  ),
  card(
    "se-topological-sort",
    "Topological sort",
    "A topological sort orders the nodes of a directed acyclic graph so every directed edge points from an earlier node to a later node.",
    "Build systems",
    ["se-dependency-graph"],
    ["https://docs.python.org/3/library/graphlib.html"],
  ),
];

export const CATALOG = Object.freeze([
  deck({
    id: "linear-algebra-i",
    version: "1.0.0-example",
    title: "Linear Algebra I",
    subject: "Mathematics",
    level: "Undergraduate introduction",
    description: "A four-card vector-space example for the study and graph flows.",
    coverageSummary: "Scalars, vectors, linear combinations, and span.",
    tags: ["mathematics", "linear-algebra", "public-example"],
    cards: linearAlgebraCards,
  }),
  deck({
    id: "introductory-mechanics",
    version: "1.0.0-example",
    title: "Introductory Mechanics",
    subject: "Physics",
    level: "Introductory college",
    description: "A compact example connecting motion, force, momentum, work, and energy.",
    coverageSummary: "Kinematics, forces, Newton's second law, momentum, work, and kinetic energy.",
    tags: ["physics", "mechanics", "public-example"],
    cards: mechanicsCards,
  }),
  deck({
    id: "software-engineering-foundations",
    version: "1.0.0-example",
    title: "Software Engineering Foundations",
    subject: "Software Engineering",
    level: "Introductory",
    description: "A two-card example showing how graph concepts support build ordering.",
    coverageSummary: "Dependency graphs, explicit edge conventions, and topological sorting.",
    tags: ["software-engineering", "graphs", "public-example"],
    cards: softwareEngineeringCards,
  }),
]);

const catalogById = new Map(CATALOG.map((item) => [item.id, item]));

export function getCatalogDeck(id) {
  return catalogById.get(id) ?? null;
}

export function catalogSummary(deckOrId) {
  const source = typeof deckOrId === "string" ? getCatalogDeck(deckOrId) : deckOrId;
  if (!source) return null;

  const {
    cards: _cards,
    ...summary
  } = source;
  return Object.freeze(summary);
}
