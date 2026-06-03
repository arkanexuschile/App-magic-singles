type NullableNumber = number | null | undefined;

function toNonNegativeInt(value: NullableNumber): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveScheduledBlockProgress(params: {
  isRunning: boolean;
  processedBlocks: NullableNumber;
  totalBlocks: NullableNumber;
  remainingBlocks: NullableNumber;
  processedVariants?: NullableNumber;
  totalVariants?: NullableNumber;
}) {
  let processed = toNonNegativeInt(params.processedBlocks) ?? 0;
  let total = toNonNegativeInt(params.totalBlocks);
  let remaining = toNonNegativeInt(params.remainingBlocks);

  if (total === null && remaining !== null) {
    total = processed + remaining;
  }
  if (remaining === null && total !== null) {
    remaining = Math.max(total - processed, 0);
  }

  if (params.isRunning) {
    if (processed === 0) {
      processed = 1;
    }
    if (total !== null && total < processed) {
      total = processed;
    }
    if (total === null && processed > 0) {
      total = processed + 1;
      remaining = 1;
    }
    if (remaining === null && total !== null) {
      remaining = Math.max(total - processed, 0);
    }

    const processedVariants = toNonNegativeInt(params.processedVariants);
    const totalVariants = toNonNegativeInt(params.totalVariants);
    if (total !== null && total > 0 && processedVariants !== null && totalVariants !== null) {
      const clampedProcessedVariants = Math.min(processedVariants, totalVariants);
      const cardsPerBlock = Math.max(1, Math.ceil(totalVariants / total));
      const derivedProcessed = Math.max(
        1,
        Math.min(total, Math.ceil(clampedProcessedVariants / cardsPerBlock)),
      );
      processed = Math.max(processed, derivedProcessed);
      remaining = Math.max(total - processed, 0);
    }
  } else {
    if (total === null) {
      total = processed;
    }
    if (remaining === null) {
      remaining = Math.max(total - processed, 0);
    }
  }

  const hasEstimate = Boolean((total ?? 0) > 0 || processed > 0 || (remaining ?? 0) > 0);
  return {
    processed,
    total: total ?? 0,
    remaining: remaining ?? 0,
    hasEstimate,
  };
}
