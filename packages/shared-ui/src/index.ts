export { renderSiteNav, initSiteNav, getEnvPrefix } from './nav.js';
export { injectSiteNavStyles } from './nav-styles.js';
export type { SiteNavOptions, NavSubItem, NavTool, NavSmallTool } from './types.js';

export { formatDateFi } from './format.js';

export {
  ACTIVE_COMPETITION_KEY,
  COMPETITIONS_API,
  CompetitionApiError,
  clearActiveCompetition,
  competitionLabel,
  createCompetition,
  deleteCompetition,
  extractCompetitionList,
  getActiveCompetition,
  isPlatformCompetition,
  listCompetitions,
  normalizeCompetitionCode,
  parseActiveCompetition,
  refreshActiveCompetition,
  serializeActiveCompetition,
  setActiveCompetition,
  subscribeActiveCompetition,
  toPlatformCompetition,
} from './competition.js';
export type { PlatformCompetition, NewCompetitionInput } from './competition.js';

export {
  competitionFileUrl,
  competitionFilesUrl,
  deleteCompetitionFile,
  extractPoolFileList,
  listCompetitionFiles,
  toPoolFile,
  uploadCompetitionFile,
} from './competition-files.js';
export type { PoolFile, PoolFileSource } from './competition-files.js';

export {
  matchCategory,
  parseFilenameGeneric,
  sortCategoriesForMatching,
} from './category-recognition.js';
export type { CategoryInfo, ParsedFilename } from './category-recognition.js';

export {
  SUFFIX_SLOTS,
  applyOutcomeLocally,
  matchNameTokens,
  normalizeMatchName,
  planAutoAssignment,
  slotOccupant,
  stripTrailingDashes,
} from './protocol-auto-assign.js';
export type {
  AutoAssignKind,
  AutoAssignOutcome,
  AutoAssignTarget,
  CategoryLike,
  FileMetaLike,
  SegmentLike,
  SegmentRole,
  StructureLike,
  SuffixSlot,
  TrayReason,
} from './protocol-auto-assign.js';

export {
  initCompetitionSelector,
  openCreateCompetitionDialog,
} from './competition-selector.js';
