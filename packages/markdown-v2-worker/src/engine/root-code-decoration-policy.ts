export interface RootCodeDecorationPlan {
  readonly tokenizeFinalizedDiff: boolean;
  readonly skipRootTokenization: boolean;
}

export function rootCodeDecorationPlan(
  isFinalized: boolean,
  isDiff: boolean,
  isLazy: boolean,
): RootCodeDecorationPlan {
  return {
    tokenizeFinalizedDiff: isFinalized && isDiff,
    skipRootTokenization: isLazy || (isDiff && !isFinalized),
  };
}
