export { buildWeekPlan, applyLiveDowngrade } from "./rules";
export { computeLongRunAnchorMinutes, longestRunMinutes } from "./anchor";
export {
  raceModeForWeek,
  raceModeSupported,
  blockStartAfterRaces,
  daysUntilRace,
  painReportedBeforeRace,
  RACE_MODE_MAX_DISTANCE_KM,
  RACE_PAIN_WARNING,
  RACE_PAIN_WARNING_MIN_SCORE,
} from "./race";
export type { Race } from "./race";
export type { ActivitySample } from "./anchor";
export { decideDowngrade, findApplicableSignal, shouldAddStrides } from "./subjective";
export type { DowngradeAction } from "./subjective";
export {
  evaluateBlockBoundary,
  isBlockBoundary,
  MAX_QUALITY_LEVEL,
} from "./progression";
export type { ProgressionState, BlockEvaluationInput } from "./progression";
export {
  DEFAULT_HR_MAX,
  DEFAULT_HR_REST,
  DEFAULT_PACE_REF_SEC_PER_KM,
  heartRateZones,
  hrHint,
  nonImpactHeartRateZones,
  nonImpactHrHint,
  NON_IMPACT_HR_SHIFT_BPM,
  paceReferenceSecPerKm,
} from "./zones";
export type { HeartRateZones } from "./zones";
export { estimateEasyPace, formulaEasyPaceSecPerKm, EASY_PACE_WINDOW_DAYS, EASY_PACE_MIN_RUNS } from "./easyPace";
export type { EasyPaceSample, EasyPaceEstimate } from "./easyPace";
export { matchActivitiesToSessions, isIndoorActivity, activityModality } from "./completion";
export { NON_IMPACT_MACHINES, isNonImpactMachine, MACHINE_LABEL_FR } from "./nonImpact";
export type { CandidateSession, CandidateActivity, MatchResult } from "./completion";
export { addDays, toMonday, isoDate, parseIsoDate, fullWeeksBetween } from "./dates";
export { DAY_CODES, DAY_LABELS_FR, dayCodeToOffset, offsetToDayCode, isDayCode } from "./days";
export type { DayCode } from "./days";
export type {
  PlannerInput,
  RaceModeInput,
  RacePlanWeekInput,
  RaceWeekPosition,
  AthleteCalibration,
  PlannedSession,
  WeekPlan,
  KeptSession,
  SessionKind,
  SessionVariant,
  SessionStep,
  SubjectiveSignal,
  TrainingPhase,
  EffortZone,
  EffortZoneId,
  Modality,
  NonImpactMachine,
} from "./types";
export { buildRacePlan, planWeekFor } from "./racePlan";
export type {
  RacePlan,
  RacePlanWeek,
  RacePhase,
  RaceKeySession,
  PlanRace,
  RacePlanHistory,
  HistoryActivity,
  MpBlock,
} from "./racePlan";
export {
  predictRaceTimes,
  riegelSeconds,
  trainingPacesFromRace,
  latestRaceResult,
  RIEGEL_EXPONENT,
  MARATHON_PACE_SAFETY_FACTOR,
  LONG_RUN_PROOF_KM,
} from "./paces";
export type { RaceResult, RacePredictions, TrainingPaces } from "./paces";
export { resolveRacePlanWeek, activeGoalRace, goalRecoveryMode, trainingPhaseOf, isRaceActivity } from "./racePlanWeek";
export type { ResolvedRacePlanWeek, RacePlanWeekParams } from "./racePlanWeek";
