const {
  LIBRARIAN_BARRIER_TARGETS,
} = require("../contracts");

function nextLibrarianPeriodicOrdinal(completedTurnOrdinal, lagThreshold) {
  const completed = Number(completedTurnOrdinal);
  if (!Number.isSafeInteger(completed) || completed < 0) {
    throw new Error("Completed Librarian turn ordinal must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(lagThreshold) || lagThreshold < 1) {
    throw new Error("Librarian lag threshold must be a positive safe integer");
  }
  return (Math.floor(completed / lagThreshold) + 1) * lagThreshold;
}

function furthestLibrarianBarrierCursor(state) {
  return Math.max(
    ...LIBRARIAN_BARRIER_TARGETS.map(
      (targetKey) => Number(state?.meta?.targetCursors?.[targetKey] ?? 0),
    ),
  );
}

function findAlignedLibrarianTurn(turns, {
  minimumOrdinal,
  minimumBoundaryMessageId = 0,
} = {}) {
  if (!Array.isArray(turns)) throw new Error("Complete turn boundaries must be an array");
  if (!Number.isSafeInteger(minimumOrdinal) || minimumOrdinal < 1) {
    throw new Error("Minimum Librarian turn ordinal must be a positive safe integer");
  }
  if (!Number.isSafeInteger(minimumBoundaryMessageId) || minimumBoundaryMessageId < 0) {
    throw new Error("Minimum Librarian boundary must be a non-negative safe integer");
  }
  let low = minimumOrdinal - 1;
  let high = turns.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (Number(turns[middle]?.boundaryMessageId) >= minimumBoundaryMessageId) {
      match = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (match < 0) return null;
  return {
    turnOrdinal: match + 1,
    boundaryMessageId: Number(turns[match].boundaryMessageId),
  };
}

module.exports = {
  nextLibrarianPeriodicOrdinal,
  furthestLibrarianBarrierCursor,
  findAlignedLibrarianTurn,
};
