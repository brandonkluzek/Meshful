export function isDeckFullyMastered(metrics = {}) {
  return (
    Number(metrics.total) > 0 &&
    Number(metrics.newCount) === 0 &&
    Number(metrics.mastery) === 100
  );
}
