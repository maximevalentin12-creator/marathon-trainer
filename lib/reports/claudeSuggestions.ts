import type { MonthlySummary } from "./types";

/**
 * TODO: wire this up to the Claude API (Messages API) to generate real,
 * personalized suggestions from the month's summary once the training
 * methodology research (cahier des charges §5) gives Claude a grounded
 * basis to reason from. Stubbed for now so the report pipeline and PDF
 * layout are ready to plug a real call into.
 */
export async function generateClaudeSuggestions(
  summary: Omit<MonthlySummary, "suggestions">
): Promise<string[]> {
  void summary;
  return ["TODO — Claude-generated suggestions are not implemented yet."];
}
