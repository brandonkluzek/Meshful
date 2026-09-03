const DEMO_METADATA = Object.freeze({
  curator: "TermMesh challenge demo",
  updatedDate: "2026-08-29",
  provenance: "challenge_demo",
  reviewStatus: "not_independently_reviewed",
  contentStatus: "original_draft",
  licenseStatus: "license_pending_owner_approval",
});

function card(id, term, definition, module, prerequisites = []) {
  return Object.freeze({
    id,
    term,
    definition,
    module,
    prerequisites: Object.freeze([...prerequisites]),
  });
}

function deck({ cards, tags, ...metadata }) {
  const frozenCards = Object.freeze([...cards]);
  return Object.freeze({
    ...metadata,
    ...DEMO_METADATA,
    cardCount: frozenCards.length,
    tags: Object.freeze([...tags]),
    cards: frozenCards,
  });
}

const linearAlgebraCards = [
  card("la-scalar", "Scalar", "A scalar is a single quantity from the number system over which a vector space is defined.", "Vectors"),
  card("la-vector", "Vector", "A vector is an element of a vector space; in coordinate form it is an ordered list whose entries are scalars.", "Vectors"),
  card("la-vector-addition", "Vector addition", "Vector addition combines two vectors in the same vector space to produce another vector in that space.", "Vectors", ["la-vector"]),
  card("la-scalar-multiplication", "Scalar multiplication", "Scalar multiplication scales a vector by a scalar and returns a vector in the same vector space.", "Vectors", ["la-scalar", "la-vector"]),
  card("la-linear-combination", "Linear combination", "A linear combination is a sum of scalar multiples of vectors.", "Vectors", ["la-vector-addition", "la-scalar-multiplication"]),
  card("la-span", "Span", "The span of a set of vectors is the set of every linear combination of those vectors.", "Vectors", ["la-linear-combination"]),

  card("la-linear-equation", "Linear equation", "A linear equation is an equality in which each variable appears only to the first power and variables are not multiplied together.", "Systems", ["la-scalar"]),
  card("la-linear-system", "Linear system", "A linear system is a collection of linear equations required to hold for the same values of their variables.", "Systems", ["la-linear-equation"]),
  card("la-matrix", "Matrix", "A matrix is a rectangular array of scalars organized into rows and columns.", "Systems", ["la-scalar"]),
  card("la-augmented-matrix", "Augmented matrix", "An augmented matrix records a linear system by placing its coefficient matrix beside its constant column.", "Systems", ["la-linear-system", "la-matrix"]),
  card("la-elementary-row-operation", "Elementary row operation", "An elementary row operation swaps two rows, rescales one row by a nonzero scalar, or adds a multiple of one row to another.", "Systems", ["la-augmented-matrix"]),
  card("la-row-echelon-form", "Row echelon form", "A matrix is in row echelon form when zero rows are last and each leading nonzero entry lies to the right of the leading entry above it.", "Systems", ["la-elementary-row-operation"]),
  card("la-reduced-row-echelon-form", "Reduced row echelon form", "A matrix is in reduced row echelon form when it is in echelon form and every pivot is one and alone in its column.", "Systems", ["la-row-echelon-form"]),
  card("la-pivot-variable", "Pivot variable", "A pivot variable is a variable whose column contains a leading entry in an echelon form of the system.", "Systems", ["la-row-echelon-form"]),
  card("la-free-variable", "Free variable", "A free variable is a non-pivot variable that may be chosen independently when describing a system's solutions.", "Systems", ["la-pivot-variable"]),
  card("la-solution-set", "Solution set", "The solution set of a linear system is the set of all variable assignments that satisfy every equation in the system.", "Systems", ["la-linear-system"]),

  card("la-vector-space", "Vector space", "A vector space is a set with vector addition and scalar multiplication satisfying the vector-space axioms.", "Vector spaces", ["la-vector-addition", "la-scalar-multiplication"]),
  card("la-subspace", "Subspace", "A subspace is a subset of a vector space that contains the zero vector and is closed under addition and scalar multiplication.", "Vector spaces", ["la-vector-space"]),
  card("la-homogeneous-system", "Homogeneous system", "A homogeneous linear system is a linear system whose constant terms are all zero.", "Vector spaces", ["la-linear-system"]),
  card("la-null-space", "Null space", "The null space of a matrix is the set of vectors mapped to the zero vector by that matrix.", "Vector spaces", ["la-homogeneous-system", "la-matrix"]),
  card("la-column-space", "Column space", "The column space of a matrix is the span of its column vectors.", "Vector spaces", ["la-span", "la-matrix"]),
  card("la-linear-independence", "Linear independence", "Vectors are linearly independent when the zero vector has only the trivial linear-combination representation using them.", "Vector spaces", ["la-linear-combination"]),

  card("la-basis", "Basis", "A basis of a vector space is a linearly independent set that spans the entire space.", "Bases and coordinates", ["la-span", "la-linear-independence", "la-vector-space"]),
  card("la-dimension", "Dimension", "The dimension of a finite-dimensional vector space is the number of vectors in any basis of that space.", "Bases and coordinates", ["la-basis"]),
  card("la-standard-basis", "Standard basis", "The standard basis of a coordinate space consists of vectors having one entry equal to one and every other entry equal to zero.", "Bases and coordinates", ["la-basis"]),
  card("la-coordinate-vector", "Coordinate vector", "The coordinate vector of a vector relative to an ordered basis lists the unique coefficients used to express that vector in the basis.", "Bases and coordinates", ["la-basis"]),
  card("la-change-of-basis-matrix", "Change-of-basis matrix", "A change-of-basis matrix converts coordinate vectors written in one ordered basis into coordinates written in another.", "Bases and coordinates", ["la-coordinate-vector", "la-matrix"]),
  card("la-rank", "Rank", "The rank of a matrix is the dimension of its column space.", "Bases and coordinates", ["la-column-space", "la-dimension"]),
  card("la-nullity", "Nullity", "The nullity of a matrix is the dimension of its null space.", "Bases and coordinates", ["la-null-space", "la-dimension"]),
  card("la-rank-nullity", "Rank-nullity theorem", "For a linear map with a finite-dimensional domain, rank plus nullity equals the dimension of the domain.", "Bases and coordinates", ["la-rank", "la-nullity"]),

  card("la-linear-transformation", "Linear transformation", "A linear transformation is a map between vector spaces that preserves vector addition and scalar multiplication.", "Linear maps", ["la-vector-space"]),
  card("la-kernel", "Kernel", "The kernel of a linear transformation is the set of domain vectors sent to the zero vector.", "Linear maps", ["la-linear-transformation"]),
  card("la-image", "Image", "The image of a linear transformation is the set of all output vectors reached from vectors in its domain.", "Linear maps", ["la-linear-transformation"]),
  card("la-matrix-representation", "Matrix representation", "The matrix representation of a linear transformation records the output coordinates of basis vectors as its columns.", "Linear maps", ["la-linear-transformation", "la-coordinate-vector", "la-matrix"]),
  card("la-injective", "Injective linear transformation", "A linear transformation is injective when distinct inputs have distinct outputs, equivalently when its kernel contains only the zero vector.", "Linear maps", ["la-kernel"]),
  card("la-surjective", "Surjective linear transformation", "A linear transformation is surjective when its image equals its entire codomain.", "Linear maps", ["la-image"]),

  card("la-determinant", "Determinant", "The determinant is a scalar assigned to a square matrix that measures its signed volume scaling.", "Determinants", ["la-matrix"]),
  card("la-invertible-matrix", "Invertible matrix", "An invertible matrix is a square matrix with a matrix inverse; equivalently, its determinant is nonzero.", "Determinants", ["la-determinant"]),
  card("la-cofactor-expansion", "Cofactor expansion", "Cofactor expansion computes a determinant as a signed sum of entries times determinants of their corresponding minors.", "Determinants", ["la-determinant"]),

  card("la-eigenvector", "Eigenvector", "An eigenvector of a linear transformation is a nonzero vector whose image is a scalar multiple of itself.", "Eigenvalues", ["la-linear-transformation"]),
  card("la-eigenvalue", "Eigenvalue", "An eigenvalue is the scalar by which a linear transformation scales one of its eigenvectors.", "Eigenvalues", ["la-eigenvector"]),
  card("la-characteristic-polynomial", "Characteristic polynomial", "The characteristic polynomial of a square matrix is the determinant of the matrix minus a scalar multiple of the identity matrix.", "Eigenvalues", ["la-eigenvalue", "la-determinant"]),
  card("la-eigenspace", "Eigenspace", "The eigenspace for an eigenvalue is the null space of the matrix minus that eigenvalue times the identity matrix.", "Eigenvalues", ["la-eigenvalue", "la-null-space"]),
  card("la-diagonalizable", "Diagonalizable matrix", "A square matrix is diagonalizable when it has a basis of eigenvectors, so it is similar to a diagonal matrix.", "Eigenvalues", ["la-eigenspace", "la-basis"]),

  card("la-inner-product", "Inner product", "An inner product assigns a scalar to a pair of vectors and satisfies conjugate symmetry, linearity, and positive definiteness.", "Orthogonality", ["la-vector-space"]),
  card("la-orthogonal-vectors", "Orthogonal vectors", "Two vectors are orthogonal when their inner product is zero.", "Orthogonality", ["la-inner-product"]),
  card("la-orthonormal-basis", "Orthonormal basis", "An orthonormal basis is a basis whose vectors have unit length and are pairwise orthogonal.", "Orthogonality", ["la-orthogonal-vectors", "la-basis"]),
  card("la-gram-schmidt", "Gram-Schmidt process", "The Gram-Schmidt process turns a linearly independent list into an orthonormal list with the same span.", "Orthogonality", ["la-orthonormal-basis"]),
  card("la-orthogonal-projection", "Orthogonal projection", "The orthogonal projection onto a subspace is the closest vector in that subspace to a given vector under the inner-product distance.", "Orthogonality", ["la-inner-product", "la-subspace"]),
  card("la-least-squares", "Least-squares solution", "A least-squares solution minimizes the squared residual norm by projecting the target vector onto the matrix's column space.", "Orthogonality", ["la-orthogonal-projection", "la-column-space", "la-linear-system"]),
];

const mechanicsCards = [
  card("mech-position", "Position", "Position specifies an object's location relative to a chosen origin and coordinate system.", "Motion"),
  card("mech-displacement", "Displacement", "Displacement is the vector from an object's initial position to its final position.", "Motion", ["mech-position"]),
  card("mech-velocity", "Velocity", "Velocity is the rate at which position changes with time and includes direction.", "Motion", ["mech-displacement"]),
  card("mech-acceleration", "Acceleration", "Acceleration is the rate at which velocity changes with time.", "Motion", ["mech-velocity"]),
  card("mech-mass", "Mass", "Mass is a measure of an object's inertia and its response to a net force.", "Forces"),
  card("mech-force", "Force", "A force is an interaction that can change an object's motion and is represented by a vector.", "Forces", ["mech-acceleration"]),
  card("mech-net-force", "Net force", "Net force is the vector sum of all external forces acting on an object.", "Forces", ["mech-force"]),
  card("mech-inertia", "Inertia", "Inertia is the tendency of an object to resist a change in its velocity.", "Forces", ["mech-mass", "mech-velocity"]),
  card("mech-newton-second-law", "Newton's second law", "Newton's second law states that net force equals the time rate of change of momentum, reducing to mass times acceleration when mass is constant.", "Forces", ["mech-net-force", "mech-mass", "mech-acceleration"]),
  card("mech-momentum", "Momentum", "Linear momentum is the product of an object's mass and velocity.", "Energy and momentum", ["mech-mass", "mech-velocity"]),
  card("mech-work", "Work", "Work done by a force is the force's line integral along an object's displacement.", "Energy and momentum", ["mech-force", "mech-displacement"]),
  card("mech-kinetic-energy", "Kinetic energy", "Kinetic energy is the energy of motion, equal to one half mass times speed squared in classical mechanics.", "Energy and momentum", ["mech-mass", "mech-velocity", "mech-work"]),
];

const microeconomicsCards = [
  card("micro-scarcity", "Scarcity", "Scarcity is the condition that available resources cannot satisfy every possible use.", "Choice"),
  card("micro-opportunity-cost", "Opportunity cost", "Opportunity cost is the value of the best alternative forgone by a choice.", "Choice", ["micro-scarcity"]),
  card("micro-marginal-analysis", "Marginal analysis", "Marginal analysis compares the additional benefit and additional cost of one more unit of an action.", "Choice", ["micro-opportunity-cost"]),
  card("micro-demand", "Demand", "Demand is the relationship between a good's price and the quantities buyers are willing and able to purchase, holding other factors fixed.", "Markets"),
  card("micro-quantity-demanded", "Quantity demanded", "Quantity demanded is the amount buyers choose at one particular price.", "Markets", ["micro-demand"]),
  card("micro-supply", "Supply", "Supply is the relationship between a good's price and the quantities sellers are willing and able to offer, holding other factors fixed.", "Markets"),
  card("micro-quantity-supplied", "Quantity supplied", "Quantity supplied is the amount sellers choose to offer at one particular price.", "Markets", ["micro-supply"]),
  card("micro-equilibrium", "Market equilibrium", "Market equilibrium is the price and quantity at which quantity demanded equals quantity supplied.", "Markets", ["micro-quantity-demanded", "micro-quantity-supplied"]),
  card("micro-elasticity", "Price elasticity of demand", "Price elasticity of demand measures the percentage change in quantity demanded divided by the percentage change in price.", "Market responses", ["micro-demand"]),
  card("micro-consumer-surplus", "Consumer surplus", "Consumer surplus is the difference between buyers' willingness to pay and what they actually pay.", "Welfare", ["micro-demand", "micro-equilibrium"]),
  card("micro-producer-surplus", "Producer surplus", "Producer surplus is the difference between the price sellers receive and their minimum willingness to accept.", "Welfare", ["micro-supply", "micro-equilibrium"]),
  card("micro-externality", "Externality", "An externality is a cost or benefit of an activity borne by someone outside the deciding transaction.", "Welfare", ["micro-marginal-analysis", "micro-equilibrium"]),
];

const chemistryCards = [
  card("chem-atom", "Atom", "An atom is the smallest unit of an element that retains that element's chemical identity.", "Matter"),
  card("chem-element", "Element", "An element is a substance whose atoms all have the same number of protons.", "Matter", ["chem-atom"]),
  card("chem-isotope", "Isotope", "Isotopes are atoms of the same element with different numbers of neutrons.", "Matter", ["chem-element"]),
  card("chem-mole", "Mole", "A mole is an amount of substance containing exactly 6.02214076 times ten to the twenty-third specified entities.", "Chemical amounts", ["chem-atom"]),
  card("chem-molar-mass", "Molar mass", "Molar mass is the mass of one mole of a substance.", "Chemical amounts", ["chem-mole", "chem-element"]),
  card("chem-chemical-formula", "Chemical formula", "A chemical formula identifies the elements in a substance and their relative numbers of atoms.", "Reactions", ["chem-element"]),
  card("chem-chemical-equation", "Chemical equation", "A chemical equation represents reactants transforming into products while conserving each type of atom.", "Reactions", ["chem-chemical-formula"]),
  card("chem-stoichiometric-coefficient", "Stoichiometric coefficient", "A stoichiometric coefficient gives the relative number of particles or moles participating in a balanced chemical equation.", "Reactions", ["chem-chemical-equation", "chem-mole"]),
  card("chem-limiting-reactant", "Limiting reactant", "The limiting reactant is consumed first and therefore sets the maximum amount of product a reaction can form.", "Reactions", ["chem-stoichiometric-coefficient", "chem-molar-mass"]),
  card("chem-electronegativity", "Electronegativity", "Electronegativity is an atom's tendency to attract shared electrons in a chemical bond.", "Bonding", ["chem-atom"]),
  card("chem-ionic-bond", "Ionic bond", "An ionic bond is the electrostatic attraction between oppositely charged ions.", "Bonding", ["chem-electronegativity"]),
  card("chem-covalent-bond", "Covalent bond", "A covalent bond forms when atoms share one or more pairs of electrons.", "Bonding", ["chem-electronegativity"]),
];

const cellBiologyCards = [
  card("cell-cell-membrane", "Cell membrane", "The cell membrane is the selectively permeable boundary that separates a cell from its surroundings.", "Cell structure"),
  card("cell-phospholipid-bilayer", "Phospholipid bilayer", "A phospholipid bilayer is a two-layer sheet with hydrophilic heads facing water and hydrophobic tails facing inward.", "Cell structure", ["cell-cell-membrane"]),
  card("cell-cytosol", "Cytosol", "Cytosol is the aqueous portion of the cytoplasm in which many cellular reactions occur.", "Cell structure", ["cell-cell-membrane"]),
  card("cell-organelle", "Organelle", "An organelle is a specialized structure within a cell that performs a particular set of functions.", "Cell structure", ["cell-cytosol"]),
  card("cell-nucleus", "Nucleus", "The nucleus is the membrane-bound organelle that houses most of a eukaryotic cell's DNA.", "Information flow", ["cell-organelle"]),
  card("cell-ribosome", "Ribosome", "A ribosome is the molecular machine that translates messenger RNA into a polypeptide.", "Information flow", ["cell-organelle"]),
  card("cell-endoplasmic-reticulum", "Endoplasmic reticulum", "The endoplasmic reticulum is a membrane network involved in protein processing, lipid synthesis, and intracellular transport.", "Endomembrane system", ["cell-organelle", "cell-ribosome"]),
  card("cell-golgi-apparatus", "Golgi apparatus", "The Golgi apparatus modifies, sorts, and packages proteins and lipids received from the endoplasmic reticulum.", "Endomembrane system", ["cell-endoplasmic-reticulum"]),
  card("cell-mitochondrion", "Mitochondrion", "A mitochondrion is an organelle that couples fuel oxidation to much of a eukaryotic cell's ATP production.", "Energy", ["cell-organelle"]),
  card("cell-lysosome", "Lysosome", "A lysosome is an acidic organelle that digests and recycles cellular material.", "Endomembrane system", ["cell-golgi-apparatus"]),
  card("cell-diffusion", "Diffusion", "Diffusion is the net movement of particles from regions of higher concentration to regions of lower concentration due to random motion.", "Transport", ["cell-cell-membrane"]),
  card("cell-osmosis", "Osmosis", "Osmosis is the net movement of water across a selectively permeable membrane driven by a difference in water potential.", "Transport", ["cell-phospholipid-bilayer", "cell-diffusion"]),
];

const anatomyCards = [
  card("anat-anatomical-position", "Anatomical position", "Anatomical position is the reference posture: standing upright, facing forward, arms at the sides, and palms forward.", "Orientation"),
  card("anat-sagittal-plane", "Sagittal plane", "A sagittal plane divides the body into left and right portions.", "Orientation", ["anat-anatomical-position"]),
  card("anat-frontal-plane", "Frontal plane", "A frontal plane divides the body into anterior and posterior portions.", "Orientation", ["anat-anatomical-position"]),
  card("anat-transverse-plane", "Transverse plane", "A transverse plane divides the body into superior and inferior portions.", "Orientation", ["anat-anatomical-position"]),
  card("anat-proximal", "Proximal", "Proximal describes a structure nearer to a limb's attachment or to a chosen point of origin.", "Directional terms", ["anat-anatomical-position"]),
  card("anat-distal", "Distal", "Distal describes a structure farther from a limb's attachment or from a chosen point of origin.", "Directional terms", ["anat-proximal"]),
  card("anat-superficial", "Superficial", "Superficial describes a structure closer to the body's surface.", "Directional terms", ["anat-anatomical-position"]),
  card("anat-deep", "Deep", "Deep describes a structure farther from the body's surface.", "Directional terms", ["anat-superficial"]),
  card("anat-tissue", "Tissue", "A tissue is an organized group of cells and extracellular material that performs related functions.", "Organization"),
  card("anat-organ", "Organ", "An organ is a body structure composed of multiple tissue types working together.", "Organization", ["anat-tissue"]),
  card("anat-axial-skeleton", "Axial skeleton", "The axial skeleton comprises the bones of the skull, vertebral column, and thoracic cage.", "Skeletal system", ["anat-organ"]),
  card("anat-appendicular-skeleton", "Appendicular skeleton", "The appendicular skeleton comprises the limb bones and the girdles that attach them to the axial skeleton.", "Skeletal system", ["anat-axial-skeleton"]),
];

const civilProcedureCards = [
  card("civpro-claim", "Civil claim", "A civil claim is an asserted legal basis for obtaining a remedy from another party in a civil action.", "Starting a case"),
  card("civpro-complaint", "Complaint", "A complaint is the pleading that states the plaintiff's claims and requests relief from the court.", "Starting a case", ["civpro-claim"]),
  card("civpro-subject-matter-jurisdiction", "Subject-matter jurisdiction", "Subject-matter jurisdiction is a court's authority to hear the category of dispute presented.", "Court authority", ["civpro-claim"]),
  card("civpro-personal-jurisdiction", "Personal jurisdiction", "Personal jurisdiction is a court's authority to bind a particular defendant to its judgment.", "Court authority", ["civpro-claim"]),
  card("civpro-venue", "Venue", "Venue determines the proper geographic judicial district for an action within a court system.", "Court authority", ["civpro-subject-matter-jurisdiction", "civpro-personal-jurisdiction"]),
  card("civpro-service-of-process", "Service of process", "Service of process formally delivers the summons and complaint in a manner legally sufficient to notify a defendant.", "Starting a case", ["civpro-complaint", "civpro-personal-jurisdiction"]),
  card("civpro-answer", "Answer", "An answer is a defendant's pleading that responds to allegations and states applicable defenses.", "Pleadings", ["civpro-service-of-process"]),
  card("civpro-motion-to-dismiss", "Motion to dismiss", "A motion to dismiss asks the court to dispose of some or all claims for a threshold legal defect without deciding disputed trial facts.", "Pleadings", ["civpro-complaint", "civpro-subject-matter-jurisdiction"]),
  card("civpro-amended-pleading", "Amended pleading", "An amended pleading replaces or changes an earlier pleading subject to the governing rules and any required permission.", "Pleadings", ["civpro-complaint", "civpro-answer"]),
  card("civpro-discovery", "Discovery", "Discovery is the pretrial process through which parties obtain nonprivileged information relevant to claims and defenses.", "Pretrial", ["civpro-answer"]),
  card("civpro-summary-judgment", "Summary judgment", "Summary judgment resolves a claim or defense when no genuine dispute of material fact requires a trial and the movant is entitled to judgment as a matter of law.", "Pretrial", ["civpro-discovery", "civpro-claim"]),
  card("civpro-claim-preclusion", "Claim preclusion", "Claim preclusion bars relitigation of a claim after a valid final judgment when the governing requirements are met.", "Judgments", ["civpro-claim", "civpro-summary-judgment"]),
];

export const CATALOG = Object.freeze([
  deck({
    id: "linear-algebra-i",
    version: "0.1.0-demo",
    title: "Linear Algebra I",
    subject: "Mathematics",
    level: "Undergraduate introduction",
    description: "A connected definition deck from vectors and systems through least squares.",
    coverageSummary: "Vectors, systems, vector spaces, bases, linear maps, determinants, eigenvalues, and orthogonality.",
    tags: ["mathematics", "linear-algebra", "primary-demo"],
    cards: linearAlgebraCards,
  }),
  deck({
    id: "introductory-mechanics",
    version: "0.1.0-demo",
    title: "Introductory Mechanics",
    subject: "Physics",
    level: "Introductory college",
    description: "Core motion, force, momentum, work, and energy definitions.",
    coverageSummary: "Kinematics, forces, Newton's second law, momentum, work, and kinetic energy.",
    tags: ["physics", "mechanics"],
    cards: mechanicsCards,
  }),
  deck({
    id: "microeconomics-foundations",
    version: "0.1.0-demo",
    title: "Microeconomics Foundations",
    subject: "Economics",
    level: "Introductory college",
    description: "A compact path from constrained choice to markets and welfare.",
    coverageSummary: "Scarcity, opportunity cost, demand, supply, equilibrium, elasticity, surplus, and externalities.",
    tags: ["economics", "microeconomics"],
    cards: microeconomicsCards,
  }),
  deck({
    id: "general-chemistry-foundations",
    version: "0.1.0-demo",
    title: "General Chemistry Foundations",
    subject: "Chemistry",
    level: "Introductory college",
    description: "Foundational definitions for matter, chemical amounts, reactions, and bonding.",
    coverageSummary: "Atoms, elements, moles, formulas, reaction quantities, limiting reactants, and chemical bonds.",
    tags: ["chemistry", "general-chemistry"],
    cards: chemistryCards,
  }),
  deck({
    id: "cell-biology-foundations",
    version: "0.1.0-demo",
    title: "Cell Biology Foundations",
    subject: "Biology",
    level: "Introductory college",
    description: "A compact map of cell structure, organelles, information flow, and transport.",
    coverageSummary: "Membranes, cytosol, major eukaryotic organelles, diffusion, and osmosis.",
    tags: ["biology", "cell-biology"],
    cards: cellBiologyCards,
  }),
  deck({
    id: "human-anatomy-orientation",
    version: "0.1.0-demo",
    title: "Human Anatomy: Orientation",
    subject: "Human Anatomy",
    level: "Preclinical introduction",
    description: "Reference terms for anatomical orientation and structural organization.",
    coverageSummary: "Anatomical position, body planes, directional terms, tissues, organs, and skeletal divisions.",
    tags: ["medicine", "anatomy"],
    cards: anatomyCards,
  }),
  deck({
    id: "civil-procedure-foundations",
    version: "0.1.0-demo",
    title: "Civil Procedure Foundations",
    subject: "Law",
    level: "First-year survey",
    description: "A compact orientation to the life of a United States civil action.",
    coverageSummary: "Court authority, pleadings, service, discovery, summary judgment, and claim preclusion.",
    tags: ["law", "civil-procedure", "us-law"],
    cards: civilProcedureCards,
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
