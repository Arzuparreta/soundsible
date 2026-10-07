import { userKey } from './session';
import { createSearchHistoryStorage } from './searchHistoryStorage';
export type { SearchHistoryDomain } from './searchHistoryStorage';

const history = createSearchHistoryStorage(userKey);
export const searchHistoryEnabled = history.enabled;
export const setSearchHistoryEnabled = history.setEnabled;
export const loadRecentSearches = history.load;
export const rememberSearch = history.remember;
export const forgetSearch = history.forget;
