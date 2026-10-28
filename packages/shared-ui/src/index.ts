export { renderSiteNav, initSiteNav, getEnvPrefix } from './nav.js';
export { injectSiteNavStyles } from './nav-styles.js';
export type { SiteNavOptions, NavSubItem, NavTool, NavSmallTool } from './types.js';

export { formatDateFi, formatDateRangeFi, formatDateTimeFi, formatFileSize } from './format.js';

export {
  DOWNLOAD_DETAILS_MAX_AGE_MS,
  DOWNLOAD_EXPIRY_MARGIN_MS,
  DOWNLOAD_LINK_UNAVAILABLE,
  isDownloadLinkStale,
  openFreshDownload,
  usableDownloadUrl,
} from './download-links.js';
export type { FreshDownloadOptions } from './download-links.js';

export {
  ACTIVE_COMPETITION_KEY,
  COMPETITIONS_API,
  CompetitionApiError,
  USERS_API,
  USER_SEARCH_MIN_CHARS,
  canManageCompetition,
  clearActiveCompetition,
  competitionAccess,
  competitionLabel,
  createCompetition,
  deleteCompetition,
  extendCompetition,
  extractCompetitionList,
  getActiveCompetition,
  getMe,
  isCompetitionAccess,
  isGoneCompetitionError,
  isPlatformCompetition,
  isReadOnlyCompetition,
  leaveCompetition,
  listAccess,
  listCompetitions,
  normalizeCompetitionCode,
  ownerLabel,
  parseActiveCompetition,
  platformErrorMessage,
  readPlatformError,
  recentShareUsers,
  refreshActiveCompetition,
  removeAccess,
  retentionInfo,
  RETENTION_WARN_DAYS,
  searchHitEmail,
  searchUsers,
  serializeActiveCompetition,
  setAccess,
  setActiveCompetition,
  subscribeActiveCompetition,
  syncCompetitionSnapshot,
  toAccessGrant,
  toPlatformCompetition,
  toUserRef,
  toUserSearchHit,
  updateCompetition,
  userRefToSearchHit,
} from './competition.js';
export type {
  AccessGrant,
  CompetitionAccess,
  NewCompetitionInput,
  PlatformCompetition,
  PlatformErrorCode,
  PlatformMe,
  RemoveAccessResult,
  RetentionInfo,
  ShareRole,
  UpdateCompetitionInput,
  UserRef,
  UserSearchHit,
} from './competition.js';

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
  ACCEPT_DAYS,
  acceptHovtpSource,
  extractHovtpSourceList,
  hovtpSourceUrl,
  hovtpSourcesUrl,
  listHovtpSources,
  rejectHovtpSource,
  revokeHovtpSource,
  toHovtpSource,
} from './hovtp-sources.js';
export type {
  AcceptDays,
  AcceptHovtpSourceResult,
  HovtpSource,
  HovtpSourceStatus,
} from './hovtp-sources.js';

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
  rscTokens,
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
  classifyRosterFile,
  classifyRosterXml,
  readDocumentType,
  sniffRosterXmlStructure,
} from './roster-xml.js';
export type { RosterXmlFile, RosterXmlKind, RosterXmlSelection } from './roster-xml.js';

export { isScheduleXmlName, summarizeScheduleXml } from './schedule-xml.js';
export type { ScheduleSummary } from './schedule-xml.js';

export {
  getToolSettings,
  saveToolSettings,
  toToolSettings,
  toolSettingsUrl,
} from './tool-settings.js';
export type { SettingsTool, ToolSettings } from './tool-settings.js';

export {
  initCompetitionSelector,
  openCreateCompetitionDialog,
  openEditCompetitionDialog,
} from './competition-selector.js';

export { openShareCompetitionDialog } from './share-dialog.js';
